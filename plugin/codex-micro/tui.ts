/**
 * codex-micro (OpenCode V2 CLI plugin) — publish this terminal's session state
 * for the Codex Micro's Agent Keys.
 *
 * In V2 the server plugin runs inside the shared background service, so it has
 * no per-terminal pid, no HERDR_PANE_ID, and no Microphone permission. All of
 * that lives in the terminal, so the work happens here, in the CLI plugin.
 *
 * This plugin deliberately does NOT talk to the device. It records this
 * terminal's state (plus a heartbeat) in the slot file; `src/daemon.js` owns
 * the HID connection and expires entries by pid liveness and heartbeat age.
 *
 * State -> colour (rendered by the daemon):
 *   idle/done green solid | busy blue breath | approval amber breath | error red solid
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// The plugin directory is symlinked into OpenCode's config; resolve through the
// link so the repo's src/ modules are found. The CLI plugin loader cannot
// require() them, so they are imported when setup runs.
const ROOT = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), "..", "..")
const load = async (name: string) => {
  const mod: any = await import(pathToFileURL(path.join(ROOT, "src", name)).href)
  return mod.default ?? mod
}
let P: any
let y: any

const HEARTBEAT_MS = 15_000
const ACTION_POLL_MS = 150

type State = "idle" | "busy" | "approval" | "error"
type Pending = { id: string; sessionID: string }
type Decision = "once" | "always" | "reject"
/** Exact pane identity when this session runs inside herdr. */
type HerdrPane = { paneId: string; tabId: string | null; workspaceId: string | null }
type Claim = {
  slot: number
  pid: number
  dir: string
  state: State
  ts: number
  title?: string
  agent?: string
  herdr?: HerdrPane | null
  caps?: { dictation?: boolean; permissions?: string; textInsert?: string }
  pending?: Pending | null
  pendingTs?: number
}

function readClaims(): Claim[] {
  try {
    const v = JSON.parse(fs.readFileSync(P.SLOT_FILE, "utf8"))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function writeClaims(claims: Claim[]) {
  try {
    fs.mkdirSync(path.dirname(P.SLOT_FILE), { recursive: true })
    const tmp = `${P.SLOT_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(claims, null, 2))
    fs.renameSync(tmp, P.SLOT_FILE) // atomic; concurrent sessions can't tear the file
  } catch {}
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Structured log to a file, NOT console: console output renders inside the TUI.
 */
function log(message: string) {
  try {
    fs.mkdirSync(P.LOG_DIR, { recursive: true })
    fs.appendFileSync(path.join(P.LOG_DIR, "plugin.log"), `${new Date().toISOString()} [${process.pid}] ${message}\n`)
  } catch {}
}

export async function setup(api: any) {
  P = await load("paths.js")
  y = await load("yolo.js")
  const dir: string = api.location?.directory || api.data?.location?.default?.()?.directory || process.cwd()
  const mine = process.pid

  function toast(variant: string, title: string, message: string, duration: number) {
    try {
      api.ui.toast.show({ variant, title, message, duration })
    } catch {}
  }

  // Recording happens HERE: this process runs under the terminal, which has
  // Microphone permission. The launchd daemon does not, and macOS hands it a
  // silent stream instead of failing.
  let dictation: any = null
  try {
    const { createDictation } = await load("dictation.js")
    dictation = createDictation({
      log: (...a: any[]) => log(a.join(" ")),
      // Live transcript straight into this terminal's focused prompt.
      onText: (text: string) => {
        try {
          const target = api.renderer?.currentFocusedRenderable
          if (typeof target?.insertText === "function") target.insertText(text.startsWith(" ") ? text : ` ${text}`)
        } catch {}
      },
      onStart: () => toast("info", "Dictation", "Listening…", 1500),
      onStop: (final: string) => {
        if (!final) toast("warning", "Dictation", "No speech detected — check Sound → Input", 3000)
      },
    })
    if (!dictation.available()) {
      log("dictation deps missing (whisper-stream / model); mic key disabled")
      dictation = null
    }
  } catch (e: any) {
    log(`dictation unavailable: ${e?.message}`)
  }

  const paneId = process.env.HERDR_PANE_ID
  const herdrPane: HerdrPane | null =
    process.env.HERDR_ENV && paneId
      ? {
          paneId,
          tabId: process.env.HERDR_TAB_ID || null,
          workspaceId: process.env.HERDR_WORKSPACE_ID || null,
        }
      : null

  // Slot numbers are assigned by the daemon from tab order (src/tabs.js); the
  // `slot` field here is vestigial and ignored downstream.
  const slot = -1
  const caps = { dictation: !!dictation, permissions: "api", textInsert: "api" }

  // The service broadcasts every session's events to every terminal, so this
  // terminal only reports the root session it is currently showing (and the
  // subagents beneath it).
  const parents = new Map<string, string | undefined>()
  const states = new Map<string, State>()
  // Keep the oldest request first, matching the on-screen prompt order.
  const permissions = new Map<string, Pending>()
  const replying = new Set<string>()
  const yoloRetryAt = new Map<string, number>()
  let selected: string | undefined
  let current: State = "idle"
  let disposed = false

  function parentOf(id: string): string | undefined {
    const session = api.data.session.get(id)
    if (session) return session.parentID || undefined
    return parents.get(id)
  }

  function root(id: string | undefined): string | undefined {
    const seen = new Set<string>()
    while (id && !seen.has(id)) {
      seen.add(id)
      const parent = parentOf(id)
      if (!parent) return id
      id = parent
    }
    return undefined
  }

  function routed(): string | undefined {
    try {
      const route = api.ui.router.current()
      return route?.type === "session" ? root(route.sessionID) : undefined
    } catch {
      return undefined
    }
  }

  function owned(p: Pending) {
    return !!selected && root(p.sessionID) === selected
  }

  function firstPending(): Pending | null {
    for (const p of permissions.values()) if (owned(p)) return p
    return null
  }

  function title(): string {
    return (selected && api.data.session.get(selected)?.title) || ""
  }

  function publish(state?: State) {
    if (disposed) return
    if (state && selected) states.set(selected, state)
    let next: State = (selected && states.get(selected)) || "idle"
    const pending = firstPending()
    if (pending && next !== "error") next = "approval"
    current = next
    const all = readClaims().filter((c) => alive(c.pid))
    let me = all.find((c) => c.pid === mine)
    if (!me) {
      me = { slot, pid: mine, dir, state: next, ts: Date.now() }
      all.push(me)
    }
    me.state = next
    me.ts = Date.now()
    me.dir = dir
    me.title = title()
    me.agent = "opencode"
    me.herdr = herdrPane
    me.caps = caps
    if (pending) me.pendingTs = me.pending?.id === pending.id ? me.pendingTs || Date.now() : Date.now()
    else delete me.pendingTs
    me.pending = pending
    writeClaims(all)
  }

  function forget(id: string) {
    permissions.delete(id)
    yoloRetryAt.delete(id)
  }

  async function answerPermission(p: Pending, decision: Decision, automatic = false) {
    if (!permissions.has(p.id) || replying.has(p.id)) return
    replying.add(p.id)
    try {
      await api.data.session.permission.reply({ sessionID: p.sessionID, requestID: p.id, decision })
      forget(p.id)
      publish()
      if (automatic) y.audit(`AUTO-APPROVED ${p.id} [${path.basename(dir)}]`)
      log(`permission ${p.id} -> ${decision} (${automatic ? "YOLO" : "from pad"})`)
    } catch (e: any) {
      yoloRetryAt.set(p.id, Date.now() + 5000)
      const message = `Failed to answer permission ${p.id}: ${e?.message || JSON.stringify(e)}`
      log(message)
      toast("error", "Codex Micro", message, 5000)
    } finally {
      replying.delete(p.id)
    }
  }

  let checkingYolo = false
  async function maybeYolo() {
    if (checkingYolo || !permissions.size || !y.isActive()) return
    checkingYolo = true
    try {
      for (const p of [...permissions.values()]) {
        if (!y.isActive()) break
        if (!owned(p) || Date.now() < (yoloRetryAt.get(p.id) || 0)) continue
        await answerPermission(p, "always", true)
      }
    } finally {
      checkingYolo = false
    }
  }

  /** Pick up requests that were already open before this terminal saw them. */
  async function hydrate(id: string) {
    const members = new Set<string>([id, ...(api.data.session.family?.(id) ?? [])])
    for (const member of members) {
      try {
        await api.data.session.permission.sync(member)
        for (const request of api.data.session.permission.list(member) ?? []) {
          if (!permissions.has(request.id)) permissions.set(request.id, { id: request.id, sessionID: member })
        }
      } catch {}
    }
    if (selected === id) publish()
  }

  function syncSelection() {
    const id = routed()
    if (id === selected) return
    selected = id
    if (id && !states.has(id)) {
      const status = api.data.session.status?.(id)
      states.set(id, status === "running" || status === "busy" ? "busy" : "idle")
    }
    publish()
    if (id) void hydrate(id)
  }

  /**
   * The daemon sees the checkmark/X press but only we hold an OpenCode client,
   * so it leaves a request in the action file for us to execute.
   */
  let lastNonce = ""
  async function pollActions() {
    let req: any
    try {
      req = JSON.parse(fs.readFileSync(P.ACTION_FILE, "utf8"))
    } catch {
      return
    }
    if (!req || req.pid !== mine || req.nonce === lastNonce) return
    lastNonce = req.nonce

    if (req.type === "dictation") {
      if (!dictation) return
      // synthesise the key edges the dictation module expects
      dictation.handle("ACT10", req.phase === "start" ? 1 : 0)
      return
    }

    if (req.type !== "permission" || !["once", "always", "reject"].includes(req.response)) return
    const pending = permissions.get(req.permissionID)
    if (!pending || pending.sessionID !== req.sessionID) return
    await answerPermission(pending, req.response)
  }

  function receive({ details: event }: any) {
    if (disposed || !event) return
    const data = event.data
    if (data == null) return
    switch (event.type) {
      case "session.created":
        parents.set(data.sessionID, data.parentID || undefined)
        return
      case "session.deleted": {
        parents.delete(data.sessionID)
        states.delete(data.sessionID)
        for (const p of [...permissions.values()]) if (p.sessionID === data.sessionID) forget(p.id)
        syncSelection()
        publish()
        return
      }
      case "permission.asked":
        if (data.id && data.sessionID) permissions.set(data.id, { id: data.id, sessionID: data.sessionID })
        syncSelection()
        publish()
        void maybeYolo()
        return
      case "permission.replied": {
        const id = data.requestID || data.id
        if (id && permissions.has(id)) {
          forget(id)
          publish()
        }
        return
      }
      case "session.execution.started":
      case "session.execution.succeeded":
      case "session.execution.interrupted":
      case "session.execution.failed": {
        // Subagent lifecycles never drive the key; only the root session does.
        if (parentOf(data.sessionID)) return
        const state: State =
          event.type === "session.execution.started" ? "busy" : event.type === "session.execution.failed" ? "error" : "idle"
        states.set(data.sessionID, state)
        if (data.sessionID === selected) publish()
        return
      }
      case "session.updated":
      case "session.renamed":
        if (data.sessionID === selected) publish()
        return
    }
  }

  const unsubscribe = api.data.listen(receive)

  const actionTimer = setInterval(() => {
    syncSelection()
    void pollActions()
    // The pad can arm YOLO AFTER permission.asked fired. Check shared state
    // even when no action file was written, so already-open prompts are handled.
    void maybeYolo()
  }, ACTION_POLL_MS)
  ;(actionTimer as any).unref?.()

  // Heartbeat: lets the daemon expire this terminal even if it is SIGKILLed.
  const beat = setInterval(() => publish(), HEARTBEAT_MS)
  ;(beat as any).unref?.()

  // Best-effort tidy-up. Not relied upon -- the daemon is the safety net.
  const release = () => {
    if (disposed) return
    disposed = true
    clearInterval(beat)
    clearInterval(actionTimer)
    try {
      unsubscribe?.()
    } catch {}
    process.removeListener("exit", release)
    process.removeListener("SIGINT", release)
    process.removeListener("SIGTERM", release)
    writeClaims(readClaims().filter((c) => c.pid !== mine && alive(c.pid)))
  }
  process.once("exit", release)
  process.once("SIGINT", release)
  process.once("SIGTERM", release)

  syncSelection()
  publish()

  return release
}

export default {
  id: "codex-micro.cli",
  setup,
}
