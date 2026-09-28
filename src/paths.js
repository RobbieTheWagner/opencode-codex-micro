/**
 * Path and binary resolution.
 *
 * Everything that used to be hardcoded lives here so the project is portable:
 *   - Homebrew is /opt/homebrew on Apple Silicon but /usr/local on Intel
 *   - state must live outside the repo (and outside opencode's config dir)
 *   - the whisper port is configurable
 */
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const ROOT = path.resolve(__dirname, "..")

/**
 * Where the code lives once installed.
 *
 * `npx github:...` executes from a temporary cache directory that npm will
 * happily delete, and LaunchAgents referencing it would silently break. So
 * setup copies the package here and points everything at this path instead.
 */
const INSTALL_DIR =
  process.env.CODEX_MICRO_HOME || path.join(os.homedir(), ".local", "share", "opencode-codex-micro")

/** True when we are running from a throwaway npx/npm cache directory. */
function isEphemeral(dir = ROOT) {
  return /[\\/](_npx|\.npm[\\/]_cacache|npm-cache)[\\/]/.test(dir) || dir.startsWith(os.tmpdir())
}

/**
 * Per-user state: slot file, caches, logs, backups. Never in the repo.
 *
 * Resolved on every access, not captured at load. Module caches are shared
 * (bun runs all test files in one process), so a snapshot taken by whichever
 * file loaded this first would pin everyone else to that directory -- and if
 * that was before CODEX_MICRO_STATE was set, to the user's LIVE state.
 */
const stateDir = () =>
  process.env.CODEX_MICRO_STATE || path.join(os.homedir(), ".local", "state", "opencode-codex-micro")
const inState = (...p) => () => path.join(stateDir(), ...p)
/** herdr's control socket is included: the daemon cannot rely on HERDR_SOCKET_PATH. */
const S = {
  HERDR_SOCKET: () =>
    process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), ".config", "herdr", "herdr.sock"),
  STATE_DIR: stateDir,
  LOG_DIR: inState("logs"),
  BACKUP_DIR: inState("backups"),
  MODEL_DIR: inState("models"),
  SLOT_FILE: inState("slots.json"),
  ACTION_FILE: inState("action.json"),
  YOLO_FILE: inState("yolo.json"),
  MIC_CACHE: inState("mic.json"),
  CONFIG_FILE: inState("config.json"),
}

const DEFAULTS = {
  whisperPort: 8178,
  whisperModel: "ggml-base.en.bin",
  yoloTtlMinutes: 15,
  approveResponse: "always", // "once" | "always"
  keys: { yolo: "ACT06", approve: "ACT07", reject: "ACT08", mic: ["ACT10", "ACT11"] },
}

function ensureDirs() {
  for (const d of [S.STATE_DIR(), S.LOG_DIR(), S.BACKUP_DIR(), S.MODEL_DIR()]) fs.mkdirSync(d, { recursive: true })
}

function config() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(S.CONFIG_FILE(), "utf8")) }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveConfig(patch) {
  ensureDirs()
  const next = { ...config(), ...patch }
  fs.writeFileSync(S.CONFIG_FILE(), JSON.stringify(next, null, 2))
  return next
}

/** Find an executable without assuming a Homebrew prefix. */
function which(name, extra = []) {
  const candidates = [
    ...extra,
    `/opt/homebrew/bin/${name}`, // Apple Silicon
    `/usr/local/bin/${name}`, // Intel
    `/usr/bin/${name}`,
  ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch {}
  }
  try {
    return execFileSync("/usr/bin/which", [name], { encoding: "utf8", timeout: 5000 }).trim() || null
  } catch {
    return null
  }
}

const bin = {
  rec: () => which("rec"),
  sox: () => which("sox"),
  whisperServer: () => which("whisper-server"),
  whisperCli: () => which("whisper-cli"),
  whisperStream: () => which("whisper-stream"),
  osascript: () => "/usr/bin/osascript",
  // HERDR_BIN_PATH is exported into every herdr pane; the daemon runs under
  // launchd and never sees it, so fall back to a normal path search.
  herdr: () => which("herdr", process.env.HERDR_BIN_PATH ? [process.env.HERDR_BIN_PATH] : []),
}

function modelPath(name = config().whisperModel) {
  return path.join(S.MODEL_DIR(), name)
}

function whisperUrl(pathname = "/inference") {
  return `http://127.0.0.1:${config().whisperPort}${pathname}`
}

module.exports = {
  ROOT,
  INSTALL_DIR,
  isEphemeral,
  DEFAULTS,
  ensureDirs,
  config,
  saveConfig,
  which,
  bin,
  modelPath,
  whisperUrl,
}
// STATE_DIR, SLOT_FILE, HERDR_SOCKET, ... read like constants but resolve live.
for (const [k, get] of Object.entries(S)) Object.defineProperty(module.exports, k, { get, enumerable: true })
