import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Exercise the real plugin and its file IPC, isolated from the running pad.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-permissions-"))
process.env.CODEX_MICRO_STATE = stateDir
const { default: plugin } = await import("../plugin/codex-micro.ts")
const timers: Array<() => void> = []
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
let hooks: any
let calls: any[]
let toasts: any[]
let reply: (options: any) => Promise<any>
let nonce = 0

const claim = () => JSON.parse(fs.readFileSync(path.join(stateDir, "slots.json"), "utf8"))[0]
const event = (type: string, properties: any) => hooks.event({ event: { type, properties } })
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
  fs.rmSync(path.join(stateDir, "action.json"), { force: true })
  yolo(false)
  globalThis.setInterval = ((fn: () => void) => {
    timers.push(fn)
    return { unref() {} }
  }) as any
  globalThis.clearInterval = (() => {}) as any
  reply = async () => ({ data: true })
  hooks = await plugin({
    directory: "/project with spaces",
    client: {
      app: { log: async () => ({ data: true }) },
      tui: { showToast: async (options: any) => { toasts.push(options); return { data: true } } },
      postSessionIdPermissionsPermissionId: async (options: any) => {
        calls.push(options)
        return reply(options)
      },
    },
  } as any)
})

afterEach(async () => {
  await hooks.dispose()
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
})
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }))

test("checkmark walks all five parallel requests oldest first", async () => {
  for (let i = 0; i < 5; i++) await ask(`p${i}`)
  for (let i = 0; i < 5; i++) {
    expect(claim().pending.id).toBe(`p${i}`)
    action(`p${i}`)
    await poll()
    expect(calls[i]).toMatchObject({
      path: { id: "session", permissionID: `p${i}` },
      query: { directory: "/project with spaces" },
      body: { response: "always" }, throwOnError: true,
    })
  }
  expect(claim().pending).toBeNull()
  expect(claim().state).toBe("busy")
})

test("busy/idle events cannot erase pending subagent permissions", async () => {
  await ask("p1", "child")
  await event("session.status", { sessionID: "parent", status: { type: "busy" } })
  await event("session.idle", { sessionID: "parent" })
  expect(claim()).toMatchObject({ state: "approval", pending: { id: "p1", sessionID: "child" } })
})

test("modern requestID replies and legacy permissionID replies remove only their request", async () => {
  await ask("p1")
  await ask("p2")
  await event("permission.replied", { requestID: "unrelated" })
  expect(claim().pending.id).toBe("p1")
  await event("permission.replied", { requestID: "p1" })
  expect(claim().pending.id).toBe("p2")
  await event("permission.replied", { permissionID: "p2" })
  expect(claim().pending).toBeNull()
})

test("arming YOLO with prompts already open drains them without another permission event", async () => {
  await ask("p1")
  await ask("p2", "child")
  await poll()
  expect(calls).toHaveLength(0)
  yolo(true)
  await poll()
  expect(calls.map((c) => c.path.permissionID)).toEqual(["p1", "p2"])
  expect(claim().pending).toBeNull()
})

test("YOLO handles new prompts and stops when disarmed", async () => {
  yolo(true)
  await ask("p1")
  await settle()
  expect(calls).toHaveLength(1)
  yolo(false)
  await ask("p2")
  await poll()
  expect(calls).toHaveLength(1)
  expect(claim().pending.id).toBe("p2")
})

test("HTTP errors keep the prompt retryable and show an error toast", async () => {
  await ask("p1")
  reply = async () => ({ error: { message: "Not found" } })
  action("p1")
  await poll()
  expect(claim()).toMatchObject({ state: "approval", pending: { id: "p1" } })
  expect(toasts[0].body.variant).toBe("error")
  reply = async () => ({ data: true })
  action("p1", "once")
  await poll()
  expect(claim().pending).toBeNull()
})

test("thrown transport errors are retained without a YOLO retry storm", async () => {
  reply = async () => { throw new Error("Network error") }
  await ask("p1")
  yolo(true)
  await poll()
  await poll()
  expect(calls).toHaveLength(1)
  expect(claim().pending.id).toBe("p1")
})

test("a reply in flight neither duplicates nor clears a newer prompt", async () => {
  let resolve!: (value: any) => void
  reply = () => new Promise((r) => { resolve = r })
  await ask("p1")
  action("p1")
  await poll()
  action("p1")
  await poll()
  await ask("p2")
  expect(calls).toHaveLength(1)
  resolve({ data: true })
  await settle()
  expect(claim()).toMatchObject({ state: "approval", pending: { id: "p2" } })
})

test("reject replies target the recorded session and ignore mismatched action files", async () => {
  await ask("p1", "child")
  action("p1", "reject", "other")
  await poll()
  expect(calls).toHaveLength(0)
  action("p1", "reject", "child")
  await poll()
  expect(calls[0]).toMatchObject({ path: { id: "child" }, body: { response: "reject" } })
})
