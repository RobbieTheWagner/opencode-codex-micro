import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Exercise the real V2 CLI plugin and its file IPC, isolated from the running pad.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-permissions-"))
process.env.CODEX_MICRO_STATE = stateDir
const { default: plugin } = await import("../plugin/codex-micro/tui.ts")
const { default: server } = await import("../plugin/codex-micro/index.ts")
const timers: Array<() => void> = []
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
let cleanup: () => void
let listener: (event: any) => void
let calls: any[]
let toasts: any[]
let reply: (options: any) => Promise<any>
let route: any
let sessions: Map<string, any>
let pendingLists: Map<string, any[]>
let nonce = 0

const claim = () => JSON.parse(fs.readFileSync(path.join(stateDir, "slots.json"), "utf8"))[0]
const event = (type: string, data: any) => listener({ details: { type, data } })
const ask = (id: string, sessionID = "session") => event("permission.asked", { id, sessionID })
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
const poll = async () => { timers[0](); await settle() }
function action(id: string, response = "always", sessionID = "session") {
  fs.writeFileSync(path.join(stateDir, "action.json"), JSON.stringify({
    type: "permission", pid: process.pid, permissionID: id, sessionID,
    response, nonce: String(++nonce),
  }))
}
function yolo(enabled: boolean) {
  fs.writeFileSync(path.join(stateDir, "yolo.json"), JSON.stringify({ enabled, expiresAt: Date.now() + 60_000 }))
}

beforeEach(async () => {
  calls = []
  toasts = []
  timers.length = 0
  route = { type: "session", sessionID: "session" }
  sessions = new Map([
    ["session", { id: "session", title: "Root" }],
    ["child", { id: "child", parentID: "session" }],
    ["other", { id: "other", title: "Other" }],
  ])
  pendingLists = new Map()
  fs.rmSync(path.join(stateDir, "action.json"), { force: true })
  yolo(false)
  globalThis.setInterval = ((fn: () => void) => {
    timers.push(fn)
    return { unref() {} }
  }) as any
  globalThis.clearInterval = (() => {}) as any
  reply = async () => undefined
  cleanup = await plugin.setup({
    location: { directory: "/project with spaces" },
    renderer: {},
    ui: {
      toast: { show: (options: any) => toasts.push(options) },
      router: { current: () => route },
    },
    data: {
      listen: (fn: any) => { listener = fn; return () => {} },
      session: {
        get: (id: string) => sessions.get(id),
        family: (id: string) => [...sessions.values()].filter((s) => s.parentID === id).map((s) => s.id),
        status: () => "idle",
        permission: {
          sync: async () => {},
          list: (id: string) => pendingLists.get(id) ?? [],
          reply: async (options: any) => {
            calls.push(options)
            return reply(options)
          },
        },
      },
    },
  })
  await settle()
})

afterEach(() => {
  cleanup()
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
})
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }))

test("checkmark walks all five parallel requests oldest first", async () => {
  for (let i = 0; i < 5; i++) ask(`p${i}`)
  event("session.execution.started", { sessionID: "session" })
  for (let i = 0; i < 5; i++) {
    expect(claim().pending.id).toBe(`p${i}`)
    action(`p${i}`)
    await poll()
    expect(calls[i]).toEqual({ sessionID: "session", requestID: `p${i}`, decision: "always" })
  }
  expect(claim().pending).toBeNull()
  expect(claim()).toMatchObject({ state: "busy", title: "Root", dir: "/project with spaces" })
})

test("busy/idle events cannot erase pending subagent permissions", async () => {
  ask("p1", "child")
  event("session.execution.started", { sessionID: "session" })
  event("session.execution.succeeded", { sessionID: "session" })
  expect(claim()).toMatchObject({ state: "approval", pending: { id: "p1", sessionID: "child" } })
})

test("subagent execution events do not drive the key", async () => {
  event("session.execution.failed", { sessionID: "child", error: { message: "x" } })
  expect(claim().state).toBe("idle")
  event("session.execution.failed", { sessionID: "session", error: { message: "x" } })
  expect(claim().state).toBe("error")
})

test("requests from sessions this terminal is not showing are ignored", async () => {
  ask("p1", "other")
  expect(claim().pending).toBeNull()
  route = { type: "session", sessionID: "other" }
  await poll()
  expect(claim()).toMatchObject({ pending: { id: "p1" }, title: "Other" })
})

test("already-open requests are picked up when a session is shown", async () => {
  pendingLists.set("other", [{ id: "old" }])
  route = { type: "session", sessionID: "other" }
  await poll()
  expect(claim().pending).toEqual({ id: "old", sessionID: "other" })
})

test("replies remove only their own request", async () => {
  ask("p1")
  ask("p2")
  event("permission.replied", { sessionID: "session", requestID: "unrelated" })
  expect(claim().pending.id).toBe("p1")
  event("permission.replied", { sessionID: "session", requestID: "p1" })
  expect(claim().pending.id).toBe("p2")
  event("permission.replied", { sessionID: "session", requestID: "p2" })
  expect(claim().pending).toBeNull()
})

test("arming YOLO with prompts already open drains them without another permission event", async () => {
  ask("p1")
  ask("p2", "child")
  await poll()
  expect(calls).toHaveLength(0)
  yolo(true)
  await poll()
  expect(calls.map((c) => c.requestID)).toEqual(["p1", "p2"])
  expect(claim().pending).toBeNull()
})

test("YOLO handles new prompts and stops when disarmed", async () => {
  yolo(true)
  ask("p1")
  await settle()
  expect(calls).toHaveLength(1)
  yolo(false)
  ask("p2")
  await poll()
  expect(calls).toHaveLength(1)
  expect(claim().pending.id).toBe("p2")
})

test("failed replies keep the prompt retryable and show an error toast", async () => {
  ask("p1")
  reply = async () => { throw new Error("Not found") }
  action("p1")
  await poll()
  expect(claim()).toMatchObject({ state: "approval", pending: { id: "p1" } })
  expect(toasts[0].variant).toBe("error")
  reply = async () => undefined
  action("p1", "once")
  await poll()
  expect(claim().pending).toBeNull()
})

test("thrown transport errors are retained without a YOLO retry storm", async () => {
  reply = async () => { throw new Error("Network error") }
  ask("p1")
  yolo(true)
  await poll()
  await poll()
  expect(calls).toHaveLength(1)
  expect(claim().pending.id).toBe("p1")
})

test("a reply in flight neither duplicates nor clears a newer prompt", async () => {
  let resolve!: (value: any) => void
  reply = () => new Promise((r) => { resolve = r })
  ask("p1")
  action("p1")
  await poll()
  action("p1")
  await poll()
  ask("p2")
  expect(calls).toHaveLength(1)
  resolve(undefined)
  await settle()
  expect(claim()).toMatchObject({ state: "approval", pending: { id: "p2" } })
})

test("reject replies target the recorded session and ignore mismatched action files", async () => {
  ask("p1", "child")
  action("p1", "reject", "other")
  await poll()
  expect(calls).toHaveLength(0)
  action("p1", "reject", "child")
  await poll()
  expect(calls[0]).toEqual({ sessionID: "child", requestID: "p1", decision: "reject" })
})

test("server plugin allows prompts only while YOLO is armed", async () => {
  let hook: (event: any) => void = () => {}
  await server.setup({
    location: { directory: "/project" },
    permission: { hook: async (_name: string, fn: any) => { hook = fn } },
  })
  const ev = () => ({ action: "edit", resources: ["a.ts"], effect: "ask" as string })
  const off = ev()
  hook(off)
  expect(off.effect).toBe("ask")
  yolo(true)
  const on = ev()
  hook(on)
  expect(on.effect).toBe("allow")
  const denied = { ...ev(), effect: "deny" }
  hook(denied)
  expect(denied.effect).toBe("deny")
})
