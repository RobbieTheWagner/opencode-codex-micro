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

const SLOT_FILE = P.SLOT_FILE
const ACTION_FILE = P.ACTION_FILE
const HEARTBEAT_MS = 15_000
const ACTION_POLL_MS = 150

type State = "idle" | "busy" | "approval" | "error"
type Pending = { id: string; sessionID: string }
type Claim = {
  slot: number
  pid: number
  dir: string
  state: State
  ts: number
  title?: string
  caps?: { dictation?: boolean }
  pending?: Pending | null
  pendingTs?: number
}

function readClaims(): Claim[] {
  try {
    const v = JSON.parse(fs.readFileSync(SLOT_FILE, "utf8"))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function writeClaims(claims: Claim[]) {
  try {
    fs.mkdirSync(path.dirname(SLOT_FILE), { recursive: true })
    const tmp = `${SLOT_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(claims, null, 2))
    fs.renameSync(tmp, SLOT_FILE) // atomic; concurrent sessions can't tear the file
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

  // Slot numbers are assigned by the daemon from Ghostty tab order
  // (scripts/codex-tabs.js), so every session just registers itself. The
  // `slot` field here is vestigial and ignored downstream.
  const claims = readClaims().filter((c) => alive(c.pid))
  const slot = -1

  claims.push({ slot, pid: mine, dir, state: "idle", ts: Date.now() })
  writeClaims(claims)

  let current: State = "idle"
  let pending: Pending | null = null

  function log(message: string) {
    return client.app
      .log({ body: { service: "codex-micro", level: "info", message } })
      .catch(() => {})
  }

  /** If YOLO is armed, approve this permission over the API immediately. */
  async function maybeYolo(id: string, sessionID: string) {
    try {
      const y = require_("../src/yolo.js")
      if (!y.isActive()) return
      await client.postSessionIdPermissionsPermissionId({
        path: { id: sessionID, permissionID: id },
        body: { response: "always" },
      })
      y.audit(`AUTO-APPROVED ${id} [${path.basename(dir)}]`)
      await log(`YOLO auto-approved ${id}`)
      pending = null
      publish("busy")
    } catch (e: any) {
      await log(`YOLO auto-approve failed: ${e?.message || e}`)
    }
  }
  // opencode titles the terminal "OC | <session title>"; the daemon matches
  // this against the focused Ghostty tab to target the right session.
  let sessionTitle = ""

  function publish(state: State) {
    current = state
    const all = readClaims().filter((c) => alive(c.pid))
    const me = all.find((c) => c.pid === mine)
    if (me) {
      me.state = state
      me.ts = Date.now()
      me.title = sessionTitle
      me.agent = "opencode"
      me.caps = { dictation: !!dictation, permissions: "api", textInsert: "api" }
      me.pending = pending
      if (pending) me.pendingTs = me.pendingTs || Date.now()
      else delete me.pendingTs
    } else {
      all.push({
        slot, pid: mine, dir, state, ts: Date.now(), title: sessionTitle,
        agent: "opencode",
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
      req = JSON.parse(fs.readFileSync(ACTION_FILE, "utf8"))
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

    if (!pending || pending.id !== req.permissionID) return

    try {
      await client.postSessionIdPermissionsPermissionId({
        path: { id: req.sessionID, permissionID: req.permissionID },
        body: { response: req.response },
      })
      await log(`permission ${req.permissionID} -> ${req.response} (from pad)`)
      pending = null
      publish("busy")
    } catch (e: any) {
      await log(`failed to answer permission ${req.permissionID}: ${e?.message || e}`)
    }
  }

  const actionTimer = setInterval(() => void pollActions(), ACTION_POLL_MS)
  if (typeof (actionTimer as any).unref === "function") (actionTimer as any).unref()

  // Heartbeat: lets the daemon expire this session even if we are SIGKILLed
  // and never get to remove our own entry.
  const beat = setInterval(() => publish(current), HEARTBEAT_MS)
  if (typeof (beat as any).unref === "function") (beat as any).unref()

  // Best-effort tidy-up. Not relied upon -- the daemon is the safety net.
  const release = () => {
    clearInterval(beat)
    clearInterval(actionTimer)
    writeClaims(readClaims().filter((c) => c.pid !== mine && alive(c.pid)))
  }
  process.once("exit", release)
  process.once("SIGINT", release)
  process.once("SIGTERM", release)

  publish("idle")

  const subagents = new Set<string>()
  const isSub = (sid?: string) => !!sid && subagents.has(sid)

  return {
    "permission.ask": async (input: any, output: any) => {
      // YOLO mode: auto-approve everything while armed. Deliberately audited,
      // and the daemon expires it automatically so it cannot be left on.
      try {
        const y = require_("../src/yolo.js")
        if (y.isActive()) {
          output.status = "allow"
          const what = input?.type || input?.title || "permission"
          y.audit(`AUTO-APPROVED ${what} :: ${String(input?.title || "").slice(0, 120)} [${path.basename(dir)}]`)
          console.log(`[codex-status] YOLO auto-approved: ${what}`)
          return
        }
      } catch {}

      // Record what is waiting so the pad can answer it. We do not set
      // output.status -- the prompt still behaves normally on screen.
      if (input?.id && input?.sessionID) {
        pending = { id: input.id, sessionID: input.sessionID }
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
          if (info?.id) subagents.delete(info.id)
          break
        }
        case "session.status": {
          if (isSub(event.properties?.sessionID)) break
          const s = event.properties?.status
          const t = typeof s === "object" ? (s as any)?.type : s
          if (t === "busy" || t === "running") {
            pending = null
            publish("busy")
          }
          break
        }
        case "session.idle":
          if (!isSub(event.properties?.sessionID)) {
            pending = null
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
            pending = { id, sessionID }
            // YOLO answers immediately over the API. Doing it here rather than
            // in the permission.ask hook means it does not depend on a hook
            // that this build never calls.
            void maybeYolo(id, sessionID)
          } else {
            void log(`permission event without id: ${JSON.stringify(Object.keys(p))}`)
          }
          publish("approval")
          break
        }

        case "permission.replied": {
          const p = event.properties || {}
          if (!p.permissionID || (pending && pending.id === p.permissionID)) {
            pending = null
            publish(current === "approval" ? "busy" : current)
          }
          break
        }
      }
    },
  }
}

export default CodexStatusPlugin
