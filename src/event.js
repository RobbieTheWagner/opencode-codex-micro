#!/usr/bin/env node
/**
 * `codex-micro event` — the entry point every agent adapter calls.
 *
 * Accepts a peon-ping-shaped payload on stdin so existing adapter knowledge
 * transfers directly:
 *
 *   echo '{"hook_event_name":"Stop","session_id":"abc","cwd":"/x"}' \
 *     | codex-micro event --agent claude-code
 *
 * Field names vary between agents, so several spellings are accepted for each
 * value. Flags override stdin, and everything has a fallback, because a hook
 * that errors can break the host agent -- this must fail quietly.
 */
const fs = require("node:fs")
const path = require("node:path")
const session = require("./session.js")

/** First present value among several possible field names. */
function pick(obj, ...names) {
  for (const n of names) {
    const v = n.split(".").reduce((o, k) => (o == null ? o : o[k]), obj)
    if (v !== undefined && v !== null && v !== "") return v
  }
  return undefined
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return {}
    const raw = fs.readFileSync(0, "utf8").trim()
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

/** Map an agent's own event name onto our normalized vocabulary. */
const ALIASES = {
  // lifecycle
  sessionstart: "SessionStart",
  start: "SessionStart",
  beforeagent: "SessionStart",
  sessionend: "SessionEnd",
  end: "SessionEnd",
  exit: "SessionEnd",
  // work
  userpromptsubmit: "UserPromptSubmit",
  prompt: "UserPromptSubmit",
  submit: "UserPromptSubmit",
  pretooluse: "PreToolUse",
  beforetool: "PreToolUse",
  posttooluse: "PostToolUse",
  aftertool: "PostToolUse",
  // finished
  stop: "Stop",
  afteragent: "Stop",
  idle: "Stop",
  done: "Stop",
  subagentstop: "SubagentStop",
  // attention
  notification: "Notification",
  permissionrequest: "PermissionRequest",
  permission: "PermissionRequest",
  approval: "PermissionRequest",
  // failure
  posttoolusefailure: "PostToolUseFailure",
  error: "Error",
  failure: "Error",
}

function normalizeEvent(raw) {
  if (!raw) return null
  const key = String(raw).replace(/[^a-z]/gi, "").toLowerCase()
  return ALIASES[key] || (session.EVENT_STATE[raw] !== undefined ? raw : null)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const body = readStdin()

  const rawEvent =
    args.event || pick(body, "hook_event_name", "hookEventName", "event", "type", "eventType")
  const event = normalizeEvent(rawEvent)
  if (!event) {
    if (args.strict) {
      console.error(`unknown event: ${rawEvent}`)
      process.exit(2)
    }
    return // unknown events are ignored, never fatal for the host agent
  }

  const agent = args.agent || pick(body, "agent", "source", "client") || "unknown"
  const cwd =
    args.cwd || pick(body, "cwd", "workspace", "workspace_root", "project_dir", "projectDir") || process.cwd()
  const sessionId =
    args.session ||
    pick(body, "session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "id")

  // Group by agent+session when we have one, else by agent+directory: a shell
  // hook exits immediately, so there is no pid to key on.
  const sessionKey = `${agent}:${sessionId || path.resolve(cwd)}`

  const title =
    args.title || pick(body, "title", "session_title", "summary", "prompt_title") || undefined

  const caps = { permissions: "keystroke", textInsert: "paste" }
  if (args.caps) {
    try {
      Object.assign(caps, JSON.parse(args.caps))
    } catch {}
  }

  try {
    session.applyEvent({ event, sessionKey, dir: cwd, title, agent, caps })
  } catch (e) {
    if (args.strict) {
      console.error(String(e.message || e))
      process.exit(1)
    }
  }
}

try {
  main()
} catch {
  // never break the host agent
}
process.exit(0)
