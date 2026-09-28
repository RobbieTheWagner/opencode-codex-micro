/**
 * YOLO mode — auto-approve every permission request.
 *
 * Shared state between the daemon (which toggles it from the pad) and the
 * plugins (which act on it in their permission.ask hook).
 *
 * This is deliberately hedged about:
 *   - it EXPIRES automatically (default 15 min) so it cannot be left armed
 *   - the pad turns red while armed, so the state is impossible to miss
 *   - every auto-approval is appended to codex-yolo.log for audit
 */
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const P = require("./paths.js")

const auditLog = () => path.join(P.LOG_DIR, "yolo.log")
const DEFAULT_TTL_MS = (P.config().yoloTtlMinutes || 15) * 60 * 1000

function read() {
  try {
    const s = JSON.parse(fs.readFileSync(P.YOLO_FILE, "utf8"))
    if (!s || !s.enabled) return { enabled: false }
    if (s.expiresAt && Date.now() > s.expiresAt) return { enabled: false, expired: true, was: s }
    return s
  } catch {
    return { enabled: false }
  }
}

function write(state) {
  try {
    fs.mkdirSync(path.dirname(P.YOLO_FILE), { recursive: true })
    const tmp = `${P.YOLO_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, P.YOLO_FILE)
  } catch {}
}

function isActive() {
  return read().enabled === true
}

function enable(ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now()
  const state = { enabled: true, since: now, expiresAt: now + ttlMs, ttlMs }
  write(state)
  audit(`ARMED for ${Math.round(ttlMs / 60000)} min`)
  return state
}

function disable(reason = "toggled off") {
  write({ enabled: false, disabledAt: Date.now() })
  audit(`DISARMED (${reason})`)
  return { enabled: false }
}

function audit(line) {
  try {
    fs.mkdirSync(path.dirname(auditLog()), { recursive: true })
    fs.appendFileSync(auditLog(), `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

module.exports = { read, isActive, enable, disable, audit, DEFAULT_TTL_MS,
  get STATE_FILE() { return P.YOLO_FILE },
  get AUDIT_LOG() { return auditLog() },
}
