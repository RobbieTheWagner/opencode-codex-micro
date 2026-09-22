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

/** Per-user state: slot file, caches, logs, backups. Never in the repo. */
const STATE_DIR =
  process.env.CODEX_MICRO_STATE || path.join(os.homedir(), ".local", "state", "opencode-codex-micro")
const LOG_DIR = path.join(STATE_DIR, "logs")
const BACKUP_DIR = path.join(STATE_DIR, "backups")
const MODEL_DIR = path.join(STATE_DIR, "models")

const SLOT_FILE = path.join(STATE_DIR, "slots.json")
const ACTION_FILE = path.join(STATE_DIR, "action.json")
const YOLO_FILE = path.join(STATE_DIR, "yolo.json")
const MIC_CACHE = path.join(STATE_DIR, "mic.json")
const CONFIG_FILE = path.join(STATE_DIR, "config.json")

const DEFAULTS = {
  whisperPort: 8178,
  whisperModel: "ggml-base.en.bin",
  yoloTtlMinutes: 15,
  approveResponse: "always", // "once" | "always"
  keys: { yolo: "ACT06", approve: "ACT07", reject: "ACT08", mic: ["ACT10", "ACT11"] },
}

function ensureDirs() {
  for (const d of [STATE_DIR, LOG_DIR, BACKUP_DIR, MODEL_DIR]) fs.mkdirSync(d, { recursive: true })
}

function config() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveConfig(patch) {
  ensureDirs()
  const next = { ...config(), ...patch }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2))
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

/** Default herdr control socket; the daemon cannot rely on HERDR_SOCKET_PATH. */
const HERDR_SOCKET =
  process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), ".config", "herdr", "herdr.sock")

function modelPath(name = config().whisperModel) {
  return path.join(MODEL_DIR, name)
}

function whisperUrl(pathname = "/inference") {
  return `http://127.0.0.1:${config().whisperPort}${pathname}`
}

module.exports = {
  ROOT,
  INSTALL_DIR,
  isEphemeral,
  STATE_DIR,
  LOG_DIR,
  BACKUP_DIR,
  MODEL_DIR,
  SLOT_FILE,
  ACTION_FILE,
  YOLO_FILE,
  MIC_CACHE,
  CONFIG_FILE,
  HERDR_SOCKET,
  DEFAULTS,
  ensureDirs,
  config,
  saveConfig,
  which,
  bin,
  modelPath,
  whisperUrl,
}
