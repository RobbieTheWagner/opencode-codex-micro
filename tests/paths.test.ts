import { afterEach, expect, test } from "bun:test"
import * as path from "node:path"

// Guards against state paths being snapshotted at load time. bun shares one
// module cache across test files, so a snapshot pins every later file -- and
// the plugin under test -- to whatever dir was set first, possibly the user's
// LIVE state. Load order must never decide where tests write.
const P = require("../src/paths.js")
const yolo = require("../src/yolo.js")
const mic = require("../src/mic.js")

const original = process.env.CODEX_MICRO_STATE
afterEach(() => {
  if (original === undefined) delete process.env.CODEX_MICRO_STATE
  else process.env.CODEX_MICRO_STATE = original
})

test("state paths follow CODEX_MICRO_STATE after modules are loaded", () => {
  for (const dir of ["/tmp/codex-a", "/tmp/codex-b"]) {
    process.env.CODEX_MICRO_STATE = dir
    expect(P.STATE_DIR).toBe(dir)
    expect(P.SLOT_FILE).toBe(path.join(dir, "slots.json"))
    expect(P.ACTION_FILE).toBe(path.join(dir, "action.json"))
    expect(P.YOLO_FILE).toBe(path.join(dir, "yolo.json"))
    expect(P.CONFIG_FILE).toBe(path.join(dir, "config.json"))
    expect(P.LOG_DIR).toBe(path.join(dir, "logs"))
    expect(P.modelPath("m.bin")).toBe(path.join(dir, "models", "m.bin"))
    expect(yolo.STATE_FILE).toBe(path.join(dir, "yolo.json"))
    expect(yolo.AUDIT_LOG).toBe(path.join(dir, "logs", "yolo.log"))
    expect(mic.CACHE).toBe(path.join(dir, "mic.json"))
  }
})

test("paths still enumerate like plain exports", () => {
  expect(Object.keys(P)).toEqual(expect.arrayContaining(["STATE_DIR", "SLOT_FILE", "HERDR_SOCKET"]))
})
