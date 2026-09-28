/**
 * codex-status — publish opencode session state for the Codex Micro's Agent Keys.
 *
 * This plugin deliberately does NOT talk to the device. It only claims a slot
 * and records this session's state (plus a heartbeat) in codex-slots.json.
 * `scripts/codex-daemon.js` owns the HID connection and paints the LEDs.
 *
 * That split exists because opencode can SIGKILL a plugin process, and a dying
 * process cannot reliably perform an async HID write -- any "turn my own LED
 * off on exit" approach eventually strands a key lit. The daemon instead
 * expires sessions by pid liveness and heartbeat age, so crashes self-heal.
 *
 * State -> colour (rendered by the daemon):
 *   idle/done green solid | busy blue breath | approval amber breath | error red solid
 *
 * Requires layer keycodes KV_OAI_AG00..AG05 (scripts/codex-write-agentkeys.js);
 * per-key lighting is keycode-gated, not layer-gated.
 */

import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

const SLOTS = 6
const require_boot = createRequire(import.meta.url)
const P = require_boot("../src/paths.js")

const HEARTBEAT_MS = 15_000
const ACTION_POLL_MS = 150

type State = "idle" | "busy" | "approval" | "error"
type Pending = { id: string; sessionID: string }
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

export const CodexStatusPlugin: Plugin = async ({ directory, client }) => {
  // Recording happens HERE, not in the daemon: this process runs under
  // opencode -> Ghostty, which has Microphone permission. The launchd daemon
  // does not, and macOS hands it a silent stream instead of failing.
  const require_ = createRequire(import.meta.url)
  let dictation: any = null
  try {
    const { createDictation } = require_("../src/dictation.js")
    dictation = createDictation({
      // Structured log, NOT console: console output renders inside the TUI and
      // was showing up in whichever tab happened to own the recording.
      log: (...a: any[]) => {
        void client.app
          .log({ body: { service: "codex-status", level: "info", message: a.join(" ") } })
          .catch(() => {})
      },
      // Live transcript straight into THIS session's prompt.
      onText: (text: string) => {
        void client.tui.appendPrompt({ body: { text: text.startsWith(" ") ? text : ` ${text}` } }).catch(() => {})
      },
      onStart: () => {
        void client.tui
          .showToast({ body: { variant: "info", title: "Dictation", message: "Listening…", duration: 1500 } })
          .catch(() => {})
      },
      onStop: (final: string) => {
        if (!final) {
          void client.tui
            .showToast({
              body: {
                variant: "warning",
                title: "Dictation",
                message: "No speech detected — check Sound → Input",
                duration: 3000,
              },
            })
            .catch(() => {})
        }
      },
    })
    if (!dictation.available()) {
      console.warn("[codex-status] dictation deps missing (whisper-stream / model); mic key disabled")
      dictation = null
    }
  } catch (e: any) {
    console.warn("[codex-status] dictation unavailable:", e?.message)
  }

  const dir = directory || process.cwd()
  const mine = process.pid

  /**
   * Pane identity, read from the environment herdr exports into every pane.
   *
   * Recording this is what lets the daemon skip title matching entirely: it can
   * look this pane up in `herdr agent list` by id. The daemon runs under
   * launchd and has no herdr env of its own, so the link has to be established
   * here, in the process that actually lives in the pane.
   */
  const paneId = process.env.HERDR_PANE_ID
  const herdrPane: HerdrPane | null =
    process.env.HERDR_ENV && paneId
      ? {
          paneId,
          tabId: process.env.HERDR_TAB_ID || null,
          workspaceId: process.env.HERDR_WORKSPACE_ID || null,
        }
      : null

  // Slot numbers are assigned by the daemon from tab order (src/tabs.js), so
  // every session just registers itself. The `slot` field here is vestigial
  // and ignored downstream.
  const claims = readClaims().filter((c) => alive(c.pid))
  const slot = -1

  claims.push({ slot, pid: mine, dir, state: "idle", ts: Date.now(), herdr: herdrPane })
  writeClaims(claims)

  let current: State = "idle"
  // Parallel tools/subagents can all ask at once. Keep the oldest request at
  // the front, matching the prompt order, without losing the others on reply.
  const permissions = new Map<string, Pending>()
  const replying = new Set<string>()
  const yoloRetryAt = new Map<string, number>()
  const y = require_("../src/yolo.js")

  function firstPending(): Pending | null {
    return permissions.values().next().value || null
  }

  function log(message: string) {
    return client.app
      .log({ body: { service: "codex-micro", level: "info", message } })
      .catch(() => {})
  }

  async function answerPermission(p: Pending, response: "once" | "always" | "reject", automatic = false) {
    if (!permissions.has(p.id) || replying.has(p.id)) return
    replying.add(p.id)
    try {
      const result = await client.postSessionIdPermissionsPermissionId({
        path: { id: p.sessionID, permissionID: p.id },
        query: { directory: dir },
        body: { response },
        throwOnError: true,
      })
      // SDK calls normally RESOLVE with { error } for HTTP failures. Never
      // discard the prompt or claim success unless the server acknowledged it.
      if (result.error || result.data !== true) {
        throw new Error(result.error ? JSON.stringify(result.error) : "Permission reply was not acknowledged")
      }
      permissions.delete(p.id)
      yoloRetryAt.delete(p.id)
      publish(current === "approval" ? "busy" : current)
      if (automatic) y.audit(`AUTO-APPROVED ${p.id} [${path.basename(dir)}]`)
      await log(`permission ${p.id} -> ${response} (${automatic ? "YOLO" : "from pad"})`)
    } catch (e: any) {
      yoloRetryAt.set(p.id, Date.now() + 5000)
      const message = `Failed to answer permission ${p.id}: ${e?.message || JSON.stringify(e)}`
      await log(message)
      await client.tui.showToast({
        body: { variant: "error", title: "Codex Micro", message, duration: 5000 },
      }).catch(() => {})
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
        if (Date.now() < (yoloRetryAt.get(p.id) || 0)) continue
        await answerPermission(p, "always", true)
      }
    } finally {
      checkingYolo = false
    }
  }
  // opencode titles the terminal "OC | <session title>". Only the Ghostty
  // backend needs this -- under herdr the daemon matches on pane id instead.
  let sessionTitle = ""

  function publish(state: State) {
    const pending = firstPending()
    if (pending && state !== "error") state = "approval"
    current = state
    const all = readClaims().filter((c) => alive(c.pid))
    const me = all.find((c) => c.pid === mine)
    if (me) {
      me.state = state
      me.ts = Date.now()
      me.title = sessionTitle
      me.agent = "opencode"
      me.herdr = herdrPane
      me.caps = { dictation: !!dictation, permissions: "api", textInsert: "api" }
      if (pending) me.pendingTs = me.pending?.id === pending.id ? me.pendingTs || Date.now() : Date.now()
      else delete me.pendingTs
      me.pending = pending
    } else {
      all.push({
        slot, pid: mine, dir, state, ts: Date.now(), title: sessionTitle,
        agent: "opencode",
        herdr: herdrPane,
        caps: { dictation: !!dictation, permissions: "api", textInsert: "api" },
        pending, pendingTs: pending ? Date.now() : undefined,
      })
    }
    writeClaims(all)
  }

  /**
   * The daemon sees the checkmark/X press but only we hold an opencode client,
   * so it leaves a request here for us to execute.
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
      if (req.phase === "start") {
        dictation.handle("ACT10", 1)
      } else {
        dictation.handle("ACT10", 0)
      }
      return
    }

    if (req.type !== "permission" || !["once", "always", "reject"].includes(req.response)) return
    const pending = permissions.get(req.permissionID)
    if (!pending || pending.sessionID !== req.sessionID) return
    await answerPermission(pending, req.response)
  }

  const actionTimer = setInterval(() => {
    void pollActions()
    // The pad can arm YOLO AFTER permission.asked fired. Check shared state
    // even when no action file was written, so already-open prompts are handled.
    void maybeYolo()
  }, ACTION_POLL_MS)
  if (typeof (actionTimer as any).unref === "function") (actionTimer as any).unref()

  // Heartbeat: lets the daemon expire this session even if we are SIGKILLed
  // and never get to remove our own entry.
  const beat = setInterval(() => publish(current), HEARTBEAT_MS)
  if (typeof (beat as any).unref === "function") (beat as any).unref()

  // Best-effort tidy-up. Not relied upon -- the daemon is the safety net.
  const release = () => {
    clearInterval(beat)
    clearInterval(actionTimer)
    process.removeListener("exit", release)
    process.removeListener("SIGINT", release)
    process.removeListener("SIGTERM", release)
    writeClaims(readClaims().filter((c) => c.pid !== mine && alive(c.pid)))
  }
  process.once("exit", release)
  process.once("SIGINT", release)
  process.once("SIGTERM", release)

  publish("idle")

  const subagents = new Set<string>()
  const isSub = (sid?: string) => !!sid && subagents.has(sid)

  return {
    dispose: async () => release(),
    "permission.ask": async (input: any, output: any) => {
      // YOLO mode: auto-approve everything while armed. Deliberately audited,
      // and the daemon expires it automatically so it cannot be left on.
      try {
        const y = require_("../src/yolo.js")
        if (y.isActive()) {
          output.status = "allow"
          const what = input?.type || input?.title || "permission"
          y.audit(`AUTO-APPROVED ${what} :: ${String(input?.title || "").slice(0, 120)} [${path.basename(dir)}]`)
          void log(`YOLO auto-approved: ${what}`)
          return
        }
      } catch {}

      // Record what is waiting so the pad can answer it. We do not set
      // output.status -- the prompt still behaves normally on screen.
      if (input?.id && input?.sessionID) {
        permissions.set(input.id, { id: input.id, sessionID: input.sessionID })
        publish("approval")
      }
    },

    event: async ({ event }: any) => {
      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const info = event.properties?.info
          if (info?.parentID) {
            subagents.add(info.id)
            break
          }
          // root session: remember its title for focus matching
          if (info?.title && info.title !== sessionTitle) {
            sessionTitle = info.title
            publish(current)
          }
          break
        }
        case "session.deleted": {
          const info = event.properties?.info
          if (info?.id) {
            subagents.delete(info.id)
            for (const p of permissions.values()) {
              if (p.sessionID === info.id) {
                permissions.delete(p.id)
                yoloRetryAt.delete(p.id)
              }
            }
            publish(current === "approval" ? "busy" : current)
          }
          break
        }
        case "session.status": {
          if (isSub(event.properties?.sessionID)) break
          const s = event.properties?.status
          const t = typeof s === "object" ? (s as any)?.type : s
          if (t === "busy" || t === "running") {
            publish("busy")
          }
          break
        }
        case "session.idle":
          if (!isSub(event.properties?.sessionID)) {
            publish("idle")
          }
          break
        case "session.error":
          if (!isSub(event.properties?.sessionID)) publish("error")
          break
        // Permission events differ between opencode builds: the docs list
        // `permission.asked`, the SDK types define `permission.updated` with a
        // full Permission payload. Handle both, and record the id/sessionID --
        // without them we cannot answer the prompt from the pad.
        case "permission.asked":
        case "permission.updated": {
          const p = event.properties || {}
          const id = p.id || p.permissionID
          const sessionID = p.sessionID
          if (id && sessionID) {
            permissions.set(id, { id, sessionID })
            // YOLO answers immediately over the API. Doing it here rather than
            // in the permission.ask hook means it does not depend on a hook
            // that this build never calls.
          } else {
            void log(`permission event without id: ${JSON.stringify(Object.keys(p))}`)
          }
          publish("approval")
          void maybeYolo()
          break
        }

        case "permission.replied": {
          const p = event.properties || {}
          const id = p.requestID || p.permissionID || p.id
          if (id && permissions.delete(id)) {
            yoloRetryAt.delete(id)
            publish(current === "approval" ? "busy" : current)
          }
          break
        }
      }
    },
  }
}

export default CodexStatusPlugin
