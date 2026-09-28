/**
 * codex-daemon — single owner of the Codex Micro's Agent Key lighting.
 *
 * Why a daemon: opencode plugin processes can be SIGKILLed, and a dying
 * process cannot reliably perform an async HID write. Any design where the
 * exiting session is responsible for turning its own LED off will eventually
 * leave a key stuck lit. Instead:
 *
 *   plugin  -> writes session state into codex-slots.json   (pure, no HID)
 *   daemon  -> owns the HID connection, paints the LEDs from that file
 *
 * The daemon prunes entries whose owning pid is dead or whose heartbeat is
 * stale, so crashed and SIGKILLed sessions self-heal within a few seconds.
 *
 * It also handles Agent key presses, focusing the Ghostty tab for that slot.
 */
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFile, execFileSync } = require("node:child_process")
const HID = require("node-hid")
const { CM2 } = require("../vendor/cm2-agent-keys/src/device.js")
const P = require("./paths.js")
const yolo = require("./yolo.js")
const herdr = require("./herdr.js")
const { assignSlots, normTitle, titleMatches } = require("./tabs.js")


const VID = 0x303a, PID = 0x8360, USAGE_PAGE = 0xff00
const SLOTS = 6

// Action keys. Keycaps are movable; these were measured on this device.
const ACT_APPROVE = P.config().keys.approve
const ACT_REJECT = P.config().keys.reject
const TICK_MS = 2000
const STALE_MS = 90_000 // heartbeat older than this = session is gone

const COLORS = {
  idle: { color: 0x30d058, effect: "solid", speed: 0.5 },
  // shallowBreath (6) fades more smoothly than breath (4); chosen by eye,
  // since ChatGPT's own writes are not observable from the host side.
  busy: { color: 0x0a84ff, effect: "shallowBreath", speed: 0.5 },
  approval: { color: 0xff9f0a, effect: "shallowBreath", speed: 0.7 },
  error: { color: 0xff3b30, effect: "solid", speed: 0.5 },
}
const OFF = { color: 0x000000, brightness: 0, effect: "off", speed: 0 }

const log = (...a) => console.log(new Date().toISOString(), ...a)

const ACT_YOLO = P.config().keys.yolo
const DEBUG_KEYS_FLAG = path.join(P.STATE_DIR, ".debug-keys")
const MIC_KEYS = new Set(P.config().keys.mic)
const micPressed = new Set()
let micTargetPid = null

/**
 * Ask the focused session's plugin to start/stop dictation.
 *
 * The daemon cannot record: under launchd it has no Microphone permission, and
 * macOS returns a SILENT stream rather than an error. The plugin runs under
 * opencode -> Ghostty, which does have mic access, so recording happens there.
 * (The Microphone pane has no "+" button, so the launchd binary cannot be
 * granted access manually.)
 */
function requestDictation(phase) {
  // Only sessions running a plugin build with dictation support can record;
  // older sessions silently ignore the request.
  const live = liveClaims().filter((c) => c.caps && c.caps.dictation)
  if (!live.length) {
    log(
      `dictation ${phase}: no session supports dictation ` +
        `(restart an opencode session to load the current plugin)`,
    )
    return
  }
  // Unlike permissions, dictation does not need the *right* session: the
  // transcript is pasted at the cursor via the clipboard, so any session with
  // microphone access can do the recording. Prefer the focused one, else just
  // take the first -- but keep start/stop on the SAME process.
  let t
  if (phase === "start") {
    const { target } = pickTarget(live)
    // Under Ghostty a session with no title yet shows as plain "OpenCode",
    // which matches nothing. Fall back to the untitled session in that case.
    // herdr matches on pane id, so it never needs this.
    let fallback = null
    if (!target) {
      const focused = focusedGhosttyTitle()
      if (focused && normTitle(focused) === "opencode") {
        const untitled = live.filter((c) => !c.title)
        if (untitled.length === 1) fallback = untitled[0]
      }
    }
    t = target || fallback || live[0]
    micTargetPid = t.pid
  } else {
    t = live.find((c) => c.pid === micTargetPid) || null
    if (!t) {
      log(`dictation stop ignored: recording session (pid ${micTargetPid}) is gone`)
      micTargetPid = null
      return
    }
    micTargetPid = null
  }
  const req = {
    type: "dictation",
    phase,
    pid: t.pid,
    slot: t.slot,
    nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
  }
  try {
    const tmp = `${P.ACTION_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(req, null, 2))
    fs.renameSync(tmp, P.ACTION_FILE)
    log(`dictation ${phase} -> slot ${t.slot} (${path.basename(t.dir)}) pid ${t.pid}`)
  } catch (e) {
    log("failed to write action file:", e?.message || e)
  }
}

/**
 * Answer a pending permission prompt from the pad.
 *
 * The daemon sees the key press but holds no agent client, so it leaves the
 * request in the action file for the owning plugin to execute (the same channel
 * dictation uses).
 *
 * Targeting matters here in a way it does not for dictation: answering the
 * WRONG session's prompt is destructive. So we only ever act on a session that
 * actually has something pending, and when several do we require the focused
 * one to break the tie rather than picking arbitrarily.
 *
 * @param {"once"|"always"|"reject"} response
 */
function requestPermissionResponse(response) {
  const live = liveClaims()
  const waiting = live.filter((c) => c.pending && c.pending.id)
  if (!waiting.length) return log(`${response}: nothing is waiting for approval`)

  let t = waiting[0]
  if (waiting.length > 1) {
    const { target, focused } = pickTarget(live)
    t = (target && waiting.find((c) => c.pid === target.pid)) || null
    if (!t) {
      return log(
        `${response}: ${waiting.length} prompts waiting and the focused session ` +
          `(${focused || "unknown"}) is not one of them — focus the one to answer`,
      )
    }
  }

  const caps = t.caps || {}
  if (caps.permissions !== "api") {
    return log(
      `${response}: session ${t.pid} (${t.agent || "unknown"}) cannot be answered ` +
        `remotely (caps.permissions=${caps.permissions || "none"})`,
    )
  }

  const req = {
    type: "permission",
    pid: t.pid,
    slot: t.slot,
    permissionID: t.pending.id,
    sessionID: t.pending.sessionID,
    response,
    nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
  }
  try {
    const tmp = `${P.ACTION_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(req, null, 2))
    fs.renameSync(tmp, P.ACTION_FILE)
    log(`permission ${req.permissionID} -> ${response} (${path.basename(t.dir)}) pid ${t.pid}`)
  } catch (e) {
    log("failed to write action file:", e?.message || e)
  }
}

/**
 * Whole-board zone lighting. Used only to make YOLO mode unmistakable --
 * per-key agent status is a separate domain (v.oai.thstatus) and is unaffected.
 * These are runtime/reversible previews; they never touch stored config.
 */
const ZONE_NORMAL = {
  backlight: { effect: 1, brightness: 1, speed: 0.5, magic: 1, color: 0xffffff },
  underglow: { effect: 3, brightness: 1, speed: 0.55, magic: 1, color: 0xffffff },
}
const ZONE_YOLO = {
  backlight: { effect: 4, brightness: 1, speed: 0.9, magic: 1, color: 0xff0000 },
  underglow: { effect: 4, brightness: 1, speed: 0.9, magic: 1, color: 0xff0000 },
}

async function applyZones(zones) {
  if (!dev) return
  try {
    await dev.preview(zones)
  } catch (e) {
    log("zone lighting failed:", e?.message || e)
  }
}

function toggleYolo() {
  if (yolo.isActive()) {
    yolo.disable("pad toggle")
    log("YOLO DISARMED")
    void applyZones(ZONE_NORMAL)
  } else {
    const st = yolo.enable()
    log(`YOLO ARMED — auto-approving all permissions until ${new Date(st.expiresAt).toLocaleTimeString()}`)
    void applyZones(ZONE_YOLO)
  }
}

function handleMicKey(key, act) {
  if (!MIC_KEYS.has(key)) return false
  // one wide keycap covers two switches; coalesce them
  if (act === 1) {
    const wasEmpty = micPressed.size === 0
    micPressed.add(key)
    if (wasEmpty) requestDictation("start")
  } else {
    micPressed.delete(key)
    if (micPressed.size === 0) requestDictation("stop")
  }
  return true
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function liveClaims() {
  let claims = []
  try {
    claims = JSON.parse(fs.readFileSync(P.SLOT_FILE, "utf8"))
  } catch {
    return []
  }
  if (!Array.isArray(claims)) return []
  const now = Date.now()
  return claims.filter((c) => alive(c.pid) && now - (c.ts || 0) < STALE_MS)
}

/**
 * Desired LED state for all six slots.
 *
 * Slots follow GHOSTTY TAB ORDER (see codex-tabs.js), recomputed every tick, so
 * reordering tabs or opening new ones re-maps the lights automatically. The
 * `slot` recorded in the slot file by each plugin is ignored.
 */
let lastAssignment = new Map()

function desired() {
  const live = liveClaims()
  const { assignment } = assignSlots(live, log)
  lastAssignment = assignment

  const bySlot = new Map()
  for (const c of live) {
    const a = assignment.get(c.pid)
    if (a) bySlot.set(a.slot, { claim: c, ...a })
  }

  const out = []
  for (let i = 0; i < SLOTS; i++) {
    const e = bySlot.get(i)
    if (!e) {
      out.push({ id: i, ...OFF })
    } else {
      const st = COLORS[e.claim.state] || COLORS.idle
      out.push({ id: i, color: st.color, brightness: 1, effect: st.effect, speed: st.speed })
    }
  }
  return { entries: out, live, assignment, bySlot }
}

/** Focus by ABSOLUTE tab position; Cmd+N counts every tab, not just opencode ones. */
function focusGhosttyTab(tabIndex) {
  const n = tabIndex
  if (!n || n < 1 || n > 9) return false
  execFile(
    "osascript",
    [
      "-e",
      `tell application "Ghostty" to activate
       delay 0.05
       tell application "System Events" to keystroke "${n}" using command down`,
    ],
    () => {},
  )
  return true
}

/**
 * Focus the session behind a slot assignment, using whichever backend placed
 * it. herdr addresses the pane directly, so it works past the 9-tab ceiling
 * that the Cmd+N keystroke imposes and lands on the right split.
 */
function focusAssignment(hit) {
  if (hit.backend === "herdr" && hit.paneId) return herdr.focusPane(hit.paneId)
  if (hit.tabIndex) return focusGhosttyTab(hit.tabIndex)
  return false
}

/**
 * Which live session currently has focus, if we can tell.
 *
 * herdr reports this exactly (`focused` on the agent list, matched back to the
 * claim by pane id). The Ghostty path can only compare the focused window
 * title against session titles, which is fuzzy and fails outright for a session
 * that has not been named yet.
 */
function focusedGhosttyTitle() {
  try {
    const out = execFileSync(
      "osascript",
      [
        "-e",
        `tell application "System Events" to tell process "Ghostty"
           try
             return name of front window
           end try
         end tell`,
      ],
      { encoding: "utf8", timeout: 4000 },
    )
    return out.trim() || null
  } catch {
    return null
  }
}

/**
 * Pick the live session the user is looking at.
 *
 * @returns {{ target: object|null, focused: string|null }}
 */
function pickTarget(live) {
  // herdr: exact, and cheap.
  if (herdr.available()) {
    const pane = herdr.focusedAgent()
    if (pane) {
      const label = pane.terminal_title_stripped || pane.terminal_title || pane.pane_id
      const target =
        live.find((c) => c.herdr && c.herdr.paneId === pane.pane_id) ||
        // Same title fallback the slot assignment uses, for sessions that
        // cannot report a pane id.
        live.find((c) => !(c.herdr && c.herdr.paneId) && c.title && titleMatches(label, c.title)) ||
        null
      if (target) return { target, focused: label }
      // Focused pane is not one of ours (a shell, say). Say so rather than
      // guessing a neighbour — answering the wrong prompt is destructive.
      return { target: null, focused: label }
    }
  }

  const focused = focusedGhosttyTitle()
  if (!focused) return { target: null, focused: null }
  const want = normTitle(focused)
  const target =
    live.find((c) => c.title && normTitle(c.title) === want) ||
    live.find((c) => c.title && (want.startsWith(normTitle(c.title)) || normTitle(c.title).startsWith(want))) ||
    null
  return { target, focused }
}

let dev = null
let lastPainted = ""
let lastEntries = []
let lastFullPaint = 0
let yoloWasActive = false

let warnedNoDevice = false
async function connect() {
  const all = HID.devices()
  const info = all.find(
    (d) => d.vendorId === VID && d.productId === PID && d.usagePage === USAGE_PAGE,
  )
  if (!info) {
    if (!warnedNoDevice) {
      warnedNoDevice = true
      log(`device not found: enumerated ${all.length} HID device(s); ` +
          `${all.filter((d) => d.vendorId === VID).length} with vendor 0x303a`)
    }
    return null
  }
  warnedNoDevice = false
  const d = await CM2.open(info.path)
  d.on("key", (ev) => {
    const key = String(ev.key || "")
    // File flag, NOT an env var: editing the plist to add EnvironmentVariables
    // makes macOS re-evaluate the launchd job and revoke its Input Monitoring
    // grant, which breaks all device writes.
    if (fs.existsSync(DEBUG_KEYS_FLAG)) log(`key ${key} act=${ev?.act}`)

    // mic key needs both edges (hold-to-talk), so handle before the down-only guard
    if (handleMicKey(key, ev?.act)) return

    if (ev?.act !== 1) return

    if (key === ACT_YOLO) return toggleYolo()
    if (key === ACT_APPROVE) return requestPermissionResponse(P.config().approveResponse)
    if (key === ACT_REJECT) return requestPermissionResponse("reject")

    const m = /^AG(\d\d)$/.exec(key)
    if (!m) return
    const slot = Number(m[1])
    let hit = null
    for (const [pid, a] of lastAssignment) {
      if (a.slot === slot) {
        hit = { pid, ...a }
        break
      }
    }
    if (!hit) return log(`key AG${m[1]}: no session on that slot`)
    const where = hit.backend === "herdr" ? `pane ${hit.paneId}` : `tab #${hit.tabIndex}`
    if (!focusAssignment(hit)) {
      return log(`key AG${m[1]}: session has no focusable tab or pane`)
    }
    log(`key AG${m[1]} -> focus ${where} (${hit.tabTitle || "untitled"})`)
  })
  d.on("error", () => {})
  // A successful lighting RPC does not mean any physical key renders it:
  // Input can strip the vendor keycodes when saving a user layer. Inspect the
  // keymap from this process, whose HID permission can differ from the CLI's.
  try {
    log("device status:", JSON.stringify(await d.status()))
    const km = await d.readKeymap()
    const profile = km.profiles.find((p) => p.id === km.activeProfileId) || km.profiles[0]
    log("device keymap:", JSON.stringify({
      activeProfileId: km.activeProfileId,
      profile: profile?.name,
      layers: profile?.layers.map((layer) => ({
        id: layer.id,
        name: layer.name,
        lights: layer.lights,
        agentKeys: (layer.layout?.keymap || []).flat().filter((key) => /^KV_OAI_AG\d\d$/.test(key)),
      })),
    }))
  } catch (e) {
    log("device keymap inspection failed:", e?.message || e)
  }
  return d
}

async function tick() {
  if (!dev) {
    try {
      dev = await connect()
      if (dev) {
        log("device connected")
        lastPainted = "" // force a repaint
      }
    } catch (e) {
      log("open failed:", e?.message || e)
      dev = null
    }
    if (!dev) return
  }

  // auto-disarm YOLO on expiry
  if (yoloWasActive && !yolo.isActive()) {
    yoloWasActive = false
    log("YOLO expired — auto-disarmed")
    await applyZones(ZONE_NORMAL)
  } else if (!yoloWasActive && yolo.isActive()) {
    yoloWasActive = true
  }

  const { entries, live, bySlot } = desired()

  // Vendor lighting is not persistent (reverts on power-cycle / profile
  // reload), so repaint unconditionally every so often, not only on change.
  const sig = JSON.stringify(entries)
  // Full refresh occasionally: vendor lighting is not persistent and reverts on
  // power-cycle / profile reload.
  const force = Date.now() - lastFullPaint > 60_000
  if (sig === lastPainted && !force) return

  // Only write slots that actually changed. Rewriting an unchanged slot
  // restarts its animation, which looks like stuttering during a fade.
  let toWrite = entries
  if (!force && lastEntries.length === entries.length) {
    toWrite = entries.filter((e, i) => JSON.stringify(e) !== JSON.stringify(lastEntries[i]))
    if (!toWrite.length) {
      lastPainted = sig
      return
    }
  }

  try {
    await dev.setThreads(toWrite)
    lastEntries = entries
    if (force) lastFullPaint = Date.now()
    if (sig !== lastPainted) {
      const desc = [...(bySlot || new Map()).entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([slot, e]) => `${slot}=${e.claim.state}(${e.paneId || (e.tabIndex ? "tab" + e.tabIndex : "?")})`)
        .join(" ")
      log(`painted: ${desc || "(all off)"}`)
    }
    lastPainted = sig
  } catch (e) {
    log("write failed, will reconnect:", e?.message || e)
    try {
      dev.close()
    } catch {}
    dev = null
    lastPainted = ""
    lastEntries = []
  }
}

log("codex-daemon starting")
setInterval(() => void tick(), TICK_MS)
void tick()

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    log("shutting down, clearing keys")
    try {
      if (dev) await dev.setThreads([0, 1, 2, 3, 4, 5].map((id) => ({ id, ...OFF })))
    } catch {}
    process.exit(0)
  })
}
