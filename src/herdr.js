/**
 * herdr backend — enumerate and focus agent panes via herdr's socket API.
 *
 * This is the preferred source of tab order when sessions run inside herdr
 * (https://herdr.dev), and it is strictly better than the Ghostty accessibility
 * path in src/tabs.js:
 *
 *   - herdr exports HERDR_PANE_ID / HERDR_TAB_ID into every pane, so a session
 *     reports its OWN identity. No fuzzy matching of truncated tab titles, and
 *     no ambiguity when two sessions share a title.
 *   - `herdr agent list` already classifies panes by agent, so we do not have
 *     to guess which tabs are running opencode from their titles.
 *   - focusing is `herdr agent focus <pane_id>`, which addresses the pane
 *     directly instead of synthesising Cmd+N. That also lifts the 9-tab ceiling
 *     the keystroke approach imposed.
 *   - no Accessibility permission required.
 *
 * Everything here degrades to "herdr is not running" rather than throwing, so
 * the caller can fall back to the Ghostty path.
 */
const fs = require("node:fs")
const { execFile, execFileSync } = require("node:child_process")
const P = require("./paths.js")

/**
 * Cache the agent list briefly.
 *
 * `desired()` runs every tick (2s) and shells out; without a cache the daemon
 * would spawn a herdr process per tick forever. The TTL is short enough that a
 * new pane lights up within a tick or two.
 */
let cache = { agents: [], at: 0, ok: false }
const CACHE_TTL_MS = 1500
/** Longer grace used only to avoid regressing to an empty list on a blip. */
const STALE_OK_MS = 15000

/** True when a herdr server appears to be running. */
function available() {
  try {
    if (!fs.existsSync(P.HERDR_SOCKET)) return false
  } catch {
    return false
  }
  return !!P.bin.herdr()
}

/** Last API error, so callers can explain a fallback instead of going silent. */
let lastError = null
let lastErrorLoggedAt = 0
const ERROR_LOG_THROTTLE_MS = 5 * 60 * 1000

/**
 * Report an API failure at most once every few minutes.
 *
 * These are worth surfacing -- a herdr client/server protocol mismatch (the CLI
 * auto-updates, the running server does not) silently disables the whole
 * backend, and without a log the only symptom is unlit keys.
 */
function noteError(msg, log) {
  lastError = msg
  if (!log) return
  const now = Date.now()
  if (now - lastErrorLoggedAt < ERROR_LOG_THROTTLE_MS) return
  lastErrorLoggedAt = now
  log(`herdr API unavailable, falling back: ${msg}`)
}

/** Run a herdr CLI subcommand and return its parsed `result`, or null. */
function call(args, { timeout = 3000, log = null } = {}) {
  const herdr = P.bin.herdr()
  if (!herdr) {
    noteError("herdr binary not found", log)
    return null
  }
  let out
  try {
    out = execFileSync(herdr, args, {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      // The daemon has no herdr env; point the CLI at the socket explicitly so
      // it does not try to infer a session from a pane it is not running in.
      env: { ...process.env, HERDR_SOCKET_PATH: P.HERDR_SOCKET },
    })
  } catch (e) {
    // A non-zero exit still emits a JSON error body, but on stderr rather than
    // stdout. Prefer either over the raw spawn error: the body carries the
    // actual reason (e.g. protocol_mismatch), the spawn error does not.
    out = `${(e && e.stdout) || ""}`.trim() || `${(e && e.stderr) || ""}`.trim()
    if (!out) {
      noteError((e && e.message) || "herdr call failed", log)
      return null
    }
  }

  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    noteError("herdr returned non-JSON output", log)
    return null
  }

  if (parsed && parsed.error) {
    noteError(`${parsed.error.code || "error"}: ${parsed.error.message || ""}`.trim(), log)
    return null
  }
  if (!parsed || !parsed.result) {
    noteError("herdr returned no result", log)
    return null
  }

  lastError = null
  return parsed.result
}

/**
 * Agent panes in herdr's own order.
 *
 * Each entry: { pane_id, tab_id, workspace_id, agent, agent_status, focused,
 *               cwd, terminal_title }
 */
function agents(log = null) {
  const fresh = Date.now() - cache.at < CACHE_TTL_MS
  if (fresh) return cache.agents

  const result = call(["agent", "list"], { log })
  const list = result && Array.isArray(result.agents) ? result.agents : null

  if (!list) {
    // A failed call is usually a transient socket hiccup, not "every pane
    // vanished". Reporting an empty list would drop every slot assignment and
    // restart all six LED animations, so keep the last good answer for a while.
    if (Date.now() - cache.at < STALE_OK_MS) return cache.agents
    cache = { agents: [], at: Date.now(), ok: false }
    return cache.agents
  }

  cache = { agents: list, at: Date.now(), ok: true }
  return list
}

/** The focused agent pane, or null. */
function focusedAgent() {
  return agents().find((a) => a.focused) || null
}

/**
 * Focus a pane by id. Fire-and-forget: a key press must never block the HID
 * read loop waiting on a subprocess.
 */
function focusPane(paneId) {
  const herdr = P.bin.herdr()
  if (!herdr || !paneId) return false
  execFile(
    herdr,
    ["agent", "focus", paneId],
    { env: { ...process.env, HERDR_SOCKET_PATH: P.HERDR_SOCKET } },
    () => {},
  )
  return true
}

/** Pane identity of the process calling this, when it runs inside herdr. */
function selfPane() {
  const paneId = process.env.HERDR_PANE_ID
  if (!process.env.HERDR_ENV || !paneId) return null
  return {
    paneId,
    tabId: process.env.HERDR_TAB_ID || null,
    workspaceId: process.env.HERDR_WORKSPACE_ID || null,
  }
}

/** Drop the cache so the next read hits the socket. Test/debug helper. */
function reset() {
  cache = { agents: [], at: 0, ok: false }
  lastError = null
  lastErrorLoggedAt = 0
}

/** Why the last call failed, or null. */
function error() {
  return lastError
}

module.exports = { available, agents, focusedAgent, focusPane, selfPane, call, reset, error }
