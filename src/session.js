/**
 * Session registry — the contract every agent adapter writes to.
 *
 * Two kinds of owner, because agents integrate very differently:
 *
 *   pid      a long-lived plugin process (opencode). Liveness is checked with
 *            kill(pid, 0), so crashes self-heal in seconds.
 *   session  a shell hook that fires and exits (Claude Code, Gemini, ...).
 *            There is no process to watch, so these expire on a TTL and are
 *            removed explicitly on SessionEnd.
 *
 * Anything that can run a command can drive the lights; richer integration
 * (answering permissions, inserting text) is opt-in via `caps`.
 */
const fs = require("node:fs")
const path = require("node:path")
const P = require("./paths.js")

const STATES = ["idle", "busy", "approval", "error"]

/** Shell-hook sessions have no process to watch; expire them after this. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
/** Plugin sessions heartbeat; treat a silent one as gone. */
const PID_TTL_MS = 90 * 1000

function read() {
  try {
    const v = JSON.parse(fs.readFileSync(P.SLOT_FILE, "utf8"))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function write(entries) {
  try {
    P.ensureDirs()
    const tmp = `${P.SLOT_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2))
    fs.renameSync(tmp, P.SLOT_FILE) // atomic: concurrent agents cannot tear it
  } catch {}
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Entries still considered live, by whichever rule applies to each. */
function live(entries = read()) {
  const now = Date.now()
  return entries.filter((c) => {
    if (c.pid) return alive(c.pid) && now - (c.ts || 0) < PID_TTL_MS
    return now - (c.ts || 0) < SESSION_TTL_MS
  })
}

const keyOf = (e) => (e.pid ? `pid:${e.pid}` : `sid:${e.sessionKey}`)

/**
 * Create or update a session.
 * @param {{pid?:number, sessionKey?:string, dir?:string, title?:string,
 *          state?:string, agent?:string, caps?:object, pending?:object|null}} patch
 */
function upsert(patch) {
  if (!patch.pid && !patch.sessionKey) throw new Error("need pid or sessionKey")
  if (patch.state && !STATES.includes(patch.state)) {
    throw new Error(`unknown state '${patch.state}' (want ${STATES.join("|")})`)
  }

  const entries = live()
  const k = keyOf(patch)
  const existing = entries.find((e) => keyOf(e) === k)

  if (existing) {
    Object.assign(existing, patch, { ts: Date.now() })
  } else {
    entries.push({
      slot: -1, // assigned by the daemon from tab order
      state: "idle",
      agent: "unknown",
      ...patch,
      ts: Date.now(),
    })
  }
  write(entries)
  return existing || entries[entries.length - 1]
}

function remove({ pid, sessionKey }) {
  const k = keyOf({ pid, sessionKey })
  write(live().filter((e) => keyOf(e) !== k))
}

/**
 * Normalized events, matching peon-ping's vocabulary so existing adapter
 * knowledge transfers directly.
 */
const EVENT_STATE = {
  SessionStart: "idle",
  UserPromptSubmit: "busy",
  PreToolUse: "busy",
  PostToolUse: "busy",
  Stop: "idle",
  SubagentStop: null, // subagents must not clobber the parent's light
  Notification: "approval",
  PermissionRequest: "approval",
  PostToolUseFailure: "error",
  Error: "error",
  SessionEnd: null, // handled as a removal
}

/** Apply a normalized event. Returns the resulting entry, or null if removed. */
function applyEvent({ event, pid, sessionKey, dir, title, agent, caps, pending }) {
  if (!(event in EVENT_STATE)) {
    throw new Error(`unknown event '${event}' (want ${Object.keys(EVENT_STATE).join("|")})`)
  }
  if (event === "SessionEnd") {
    remove({ pid, sessionKey })
    return null
  }
  const state = EVENT_STATE[event]
  if (state === null) return null // ignored (e.g. SubagentStop)

  return upsert({
    ...(pid ? { pid } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(dir ? { dir } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(agent ? { agent } : {}),
    ...(caps ? { caps } : {}),
    ...(pending !== undefined ? { pending } : {}),
    state,
  })
}

module.exports = { read, write, live, upsert, remove, applyEvent, EVENT_STATE, STATES, alive }
