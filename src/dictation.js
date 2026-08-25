/**
 * Hold-to-talk dictation with live transcription.
 *
 * Architecture, and why it is this shape:
 *
 *   sox `rec`  -> raw 16 kHz PCM, starts INSTANTLY (no model to load)
 *   whisper-server -> warm model over HTTP, ~0.1 s per request
 *
 * Earlier attempts failed for instructive reasons:
 *   - whisper-cli per press: ~10 s of Metal/model init before it even records,
 *     so short holds produced nothing.
 *   - whisper-stream: same cold-start cost, AND it uses SDL2, whose device list
 *     and default differ from the macOS default input (it silently grabbed the
 *     built-in mic while the user spoke into AirPods).
 *
 * sox follows the macOS default input, so "the mic you picked in System
 * Settings" is simply correct, with no device-index guessing.
 *
 * The whole clip is re-transcribed each tick (cheap against a warm server, and
 * more accurate than stitching chunks) and only the new suffix is emitted.
 *
 * Runs in the PLUGIN process: under launchd there is no Microphone permission
 * and macOS returns a silent stream rather than an error.
 */
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn } = require("node:child_process")

const P = require("./paths.js")

const REC = P.bin.rec()
const SERVER = P.whisperUrl("/inference")
const HEALTH = P.whisperUrl("/")
const TMP = path.join(os.tmpdir(), "codex-dictation")

const RATE = 16000
const TICK_MS = 1200
const MIN_MS = 250
const MIN_BYTES = RATE * 2 * 0.4 // ~0.4 s of audio before the first attempt

const MIC_KEYS = new Set(P.config().keys.mic)
const NOISE = /^\s*(\[BLANK_AUDIO\]|\(.*\)|\[.*\])\s*$/i

fs.mkdirSync(TMP, { recursive: true })

/** Wrap raw s16le mono PCM in a WAV header so the server can read it. */
function wav(pcm, rate = RATE) {
  const h = Buffer.alloc(44)
  h.write("RIFF", 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write("WAVE", 8)
  h.write("fmt ", 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write("data", 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

function clean(text) {
  const t = String(text || "")
    .replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!t || NOISE.test(t)) return ""
  return t
}

/**
 * Emit only text that has STABILISED.
 *
 * Every tick re-transcribes the whole clip, and whisper revises freely -- it
 * will drop or rewrite words it emitted moments ago (an early "Cheers."
 * vanished entirely in testing). Any "diff the last output" scheme therefore
 * re-emits whole phrases.
 *
 * So: a word is only emitted once two consecutive transcriptions agree on it
 * (longest common word prefix). The volatile tail is withheld until it settles,
 * and flushed on the final tick. Costs one tick of latency; in exchange output
 * is monotonic and never duplicates.
 */
function words(s) {
  return String(s || "").split(/\s+/).filter(Boolean)
}
const bare = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "")

function commonPrefix(a, b) {
  let i = 0
  while (i < a.length && i < b.length && bare(a[i]) === bare(b[i])) i++
  return i
}

/** Stateful emitter: feed full transcripts, get back only new stable text. */
function createEmitter() {
  let prev = []
  let emitted = 0
  return {
    push(full) {
      const cur = words(full)
      const stable = commonPrefix(prev, cur)
      prev = cur
      if (stable <= emitted) return ""
      const out = cur.slice(emitted, stable).join(" ")
      emitted = stable
      return out
    },
    /** Flush everything remaining, regardless of stability. */
    flush(full) {
      const cur = words(full)
      if (cur.length <= emitted) return ""
      const out = cur.slice(emitted).join(" ")
      emitted = cur.length
      prev = cur
      return out
    },
  }
}

async function transcribe(pcm) {
  const form = new FormData()
  form.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "a.wav")
  form.append("response_format", "text")
  const res = await fetch(SERVER, { method: "POST", body: form })
  if (!res.ok) throw new Error(`whisper-server ${res.status}`)
  return clean(await res.text())
}

async function serverUp() {
  try {
    const res = await fetch(HEALTH, { method: "GET" })
    return res.status < 500
  } catch {
    return false
  }
}

function createDictation({ log, onText, onStart, onStop }) {
  const pressed = new Set()
  let proc = null
  let raw = null
  let timer = null
  let startedAt = 0
  let committed = ""
  let inFlight = false
  let emitter = createEmitter()

  async function tick(final = false) {
    if (inFlight || !raw) return
    let pcm
    try {
      pcm = fs.readFileSync(raw)
    } catch {
      return
    }
    if (pcm.length < MIN_BYTES) return
    inFlight = true
    try {
      const text = await transcribe(pcm)
      const add = final ? emitter.flush(text) : emitter.push(text)
      if (add) {
        committed = `${committed} ${add}`.replace(/\s+/g, " ").trim()
        onText && onText(add)
      }
    } catch (e) {
      if (final) log("dictation: transcription failed:", e?.message || e)
    } finally {
      inFlight = false
    }
  }

  function start() {
    if (proc) return
    committed = ""
    emitter = createEmitter()
    startedAt = Date.now()
    raw = path.join(TMP, `d-${Date.now()}.raw`)

    try {
      // raw s16le mono at 16 kHz; sox resamples from whatever the device gives
      proc = spawn(REC, ["-q", "-t", "raw", "-r", String(RATE), "-e", "signed", "-b", "16", "-c", "1", raw], {
        stdio: ["ignore", "ignore", "pipe"],
      })
      proc.stderr.on("data", (d) => {
        const s = String(d).trim()
        if (s && !/WARN formats/.test(s)) log("rec:", s)
      })
      proc.on("error", (e) => {
        log("dictation: recorder failed:", e?.message || e)
        proc = null
      })
    } catch (e) {
      log("dictation: could not start recorder:", e?.message || e)
      proc = null
      return
    }

    timer = setInterval(() => void tick(), TICK_MS)
    log("dictation: listening...")
    onStart && onStart()
  }

  async function stop() {
    if (!proc) return
    const p = proc
    const file = raw
    const held = Date.now() - startedAt
    proc = null
    clearInterval(timer)
    timer = null

    try {
      p.kill("SIGTERM")
    } catch {}

    if (held < MIN_MS) {
      log(`dictation: ignored (held ${held}ms)`)
      cleanup(file)
      return
    }

    await new Promise((r) => setTimeout(r, 200)) // let the last samples flush
    await tick(true)

    if (!committed) {
      const size = (() => {
        try {
          return fs.statSync(file).size
        } catch {
          return 0
        }
      })()
      if (!(await serverUp())) {
        log("dictation: whisper-server is not running — run `codex-micro services start`")
      } else if (size < MIN_BYTES) {
        log(`dictation: almost no audio captured (${size} bytes) — is the input device live?`)
      } else {
        log("dictation: no speech recognised — check System Settings > Sound > Input")
      }
    } else {
      log(`dictation: "${committed}"`)
    }

    onStop && onStop(committed)
    cleanup(file)
    raw = null
  }

  function cleanup(f) {
    try {
      if (f) fs.unlinkSync(f)
    } catch {}
  }

  return {
    handle(key, act) {
      if (!MIC_KEYS.has(key)) return false
      if (act === 1) {
        const wasEmpty = pressed.size === 0
        pressed.add(key)
        if (wasEmpty) start()
      } else {
        pressed.delete(key)
        if (pressed.size === 0) void stop()
      }
      return true
    },
    available() {
      return !!REC && fs.existsSync(REC)
    },
  }
}

module.exports = { createDictation, wav, clean, createEmitter, commonPrefix }
