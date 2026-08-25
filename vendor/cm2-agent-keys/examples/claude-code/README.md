# Claude Code on a Creator Micro 2

This is the setup the library was written for: my Claude Code sessions on
physical keys. What it does:

- **Row of agent keys = your Claude Code sessions.** Red = blocked on a
  permission, breathing amber = asked you a question, blue = working, green =
  done, dim white = idle. **Press a key to focus that session's iTerm2 pane.**
- **Underglow ring** mirrors the worst state across all sessions.
- A **"new session" agent key** (white pulse) opens a fresh iTerm2 tab and
  launches `claude` (configurable — including ssh'ing to another machine).
- Works for sessions on a remote box over ssh (reverse tunnel carries the hook
  events home; `SendEnv` carries the pane identity out).

## Pieces

| file | role |
|---|---|
| `daemon.py` | the brain: registry of sessions→keys, state machine, iTerm2 painting/focus (tab colours + badges too), supervises the LED service. Runs under launchd. |
| `service.js` | persistent pad connection using `cm2-agent-keys`: pushes LED state, reports key presses (JSON-lines over stdin/stdout). |
| `hook-post.sh` | one-liner relay: Claude Code hook events → daemon (never blocks, never fails). |
| `hammerspoon-init.lua` | optional keyboard fallback: Hyper+1…4 focus slots from any keyboard. |
| `com.example.wl-bridge.plist` | launchd agent definition. |

## Setup (macOS, iTerm2)

1. Pad prep: firmware ≥ v0.6.0-rc, then `cm2 backup` and `cm2 agent-row 1`
   (or whichever row you want as session keys — see the main README).
2. `python3 -m venv ~/wl-bridge/.venv && ~/wl-bridge/.venv/bin/pip install iterm2`
   and enable iTerm2's Python API (Settings → General → Magic).
3. `npm install cm2-agent-keys` somewhere `service.js` can resolve it.
4. Copy these files into `~/wl-bridge/`, fix paths in the plist, then
   `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.example.wl-bridge.plist`.
5. Add the hooks to `~/.claude/settings.json` — every event runs
   `hook-post.sh`: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`,
   `Notification`, and `PreToolUse`/`PostToolUse` with matcher
   `AskUserQuestion`.
6. Optional new-session command in `~/.config/wl-bridge.json`:
   `{"new_session_cmd": "ssh -t devbox 'cd ~/proj && ~/.local/bin/claude'\n"}`
7. Optional remote sessions: on the machine you ssh to, install the same
   hooks + `hook-post.sh`, and in your local `~/.ssh/config` add
   `RemoteForward 8377 127.0.0.1:8377` and `SendEnv LC_ITERM_SESSION_ID`
   (export `LC_ITERM_SESSION_ID="$ITERM_SESSION_ID"` in your shell rc; macOS
   sshd accepts `LC_*` by default).

State machine: `SessionStart` registers a session → `UserPromptSubmit` = blue
→ `AskUserQuestion` = amber → permission `Notification` = red → `Stop` = green
→ `SessionEnd` frees the key. Sessions are pruned automatically when their
pane disappears.
