#!/usr/bin/env node
/**
 * Resolve which SDL capture device whisper-stream should use.
 *
 * whisper-stream uses SDL2, whose device list and default are NOT the macOS
 * default input. Left alone it grabs SDL device #0 (usually the built-in mic),
 * so speaking into AirPods produced silence while sox worked fine.
 *
 * This enumerates SDL's devices, finds the current macOS default input, and
 * caches the matching index to codex-mic.json for the dictation module.
 *
 *   node scripts/codex-mic.js          # detect and cache
 *   node scripts/codex-mic.js --list   # just show devices
 */
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const P = require("./paths.js")

const CACHE = P.MIC_CACHE
const MODEL = P.modelPath()
const STREAM_BIN = P.bin.whisperStream()

/** SDL capture devices, in whisper-stream's own index order. */
function sdlDevices() {
  let out = ""
  try {
    // deliberately invalid index: makes it print the list, then exit
    out = execFileSync(STREAM_BIN, ["-m", MODEL, "--capture", "999"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    })
  } catch (e) {
    out = `${e.stdout || ""}${e.stderr || ""}`
  }
  const devices = []
  for (const line of out.split("\n")) {
    const m = /Capture device #(\d+):\s*'(.+)'/.exec(line)
    if (m) devices[Number(m[1])] = m[2]
  }
  return devices
}

/** Current macOS default input device name. */
function macDefaultInput() {
  try {
    const out = execFileSync("system_profiler", ["SPAudioDataType"], {
      encoding: "utf8",
      timeout: 20000,
    })
    const lines = out.split("\n")
    for (let i = 0; i < lines.length; i++) {
      if (/Default Input Device:\s*Yes/.test(lines[i])) {
        for (let j = i; j >= 0; j--) {
          const m = /^\s{8}(\S.*):\s*$/.exec(lines[j])
          if (m) return m[1].trim()
        }
      }
    }
  } catch {}
  return null
}

// Apple uses a curly apostrophe in device names; normalise for comparison.
const norm = (s) => String(s || "").replace(/[\u2018\u2019']/g, "'").trim().toLowerCase()

function detect() {
  const devices = sdlDevices()
  const want = macDefaultInput()
  let index = -1
  if (want) {
    index = devices.findIndex((d) => norm(d) === norm(want))
    if (index === -1) index = devices.findIndex((d) => norm(d).includes(norm(want)) || norm(want).includes(norm(d)))
  }
  return { devices, want, index }
}

if (require.main === module) {
  const { devices, want, index } = detect()
  console.log("SDL capture devices (whisper-stream indices):")
  devices.forEach((d, i) => console.log(`  #${i} ${d}${i === index ? "   <== macOS default" : ""}`))
  console.log(`\nmacOS default input: ${want || "(unknown)"}`)

  if (process.argv.includes("--list")) process.exit(0)

  if (index === -1) {
    console.log("\nCould not match the macOS default to an SDL device; leaving whisper-stream on its own default.")
    try {
      fs.unlinkSync(CACHE)
    } catch {}
    process.exit(1)
  }

  fs.writeFileSync(CACHE, JSON.stringify({ index, name: devices[index], ts: Date.now() }, null, 2))
  console.log(`\ncached -> ${CACHE}: capture #${index} '${devices[index]}'`)
}

module.exports = { detect, sdlDevices, macDefaultInput, CACHE }
