# Agent adapters

Anything that can run a command on an event can drive the Agent-key LEDs.
Adapters are one-line shims that forward the agent's hook payload to
`codex-micro event`, which normalizes event names and field spellings.

## Feature support

LEDs and key→focus work everywhere. Richer features need an API the agent
exposes; where there is none, we fall back to synthesised input.

| Feature | opencode | Every other agent |
| --- | --- | --- |
| Status LEDs | ✅ | ✅ |
| Key → focus tab | ✅ | ✅ |
| ✓ / ✗ approve-deny | ✅ SDK call | ⚠️ types `y`/`n` + Enter into the focused tab |
| YOLO auto-approve | ✅ SDK call | ⚠️ same keystroke path |
| Dictation insert | ✅ `tui.appendPrompt` | ⚠️ clipboard + ⌘V |

The keystroke path is **best-effort**: it types into whatever is focused and
assumes the TUI accepts `y`/`n`. To avoid answering the wrong prompt it only
fires when that session owns the **focused** tab.

## Normalized events

| Event | LED |
| --- | --- |
| `SessionStart` | idle |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | busy |
| `Stop` | idle |
| `Notification`, `PermissionRequest` | approval |
| `PostToolUseFailure`, `Error` | error |
| `SessionEnd` | removed |
| `SubagentStop` | ignored (must not clobber the parent) |

Agent-specific names (`AfterAgent`, `BeforeAgent`, `AfterTool`, …) are mapped
automatically, so most adapters need no per-event configuration.

## Wiring an agent

The adapter takes the event from the payload's `hook_event_name`, or as `$1`:

```sh
/path/to/adapters/claude-code.sh              # event from stdin JSON
/path/to/adapters/gemini.sh AfterAgent        # event as an argument
```

### Claude Code

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "~/.local/share/opencode-codex-micro/adapters/claude-code.sh" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "~/.local/share/opencode-codex-micro/adapters/claude-code.sh" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "~/.local/share/opencode-codex-micro/adapters/claude-code.sh" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "~/.local/share/opencode-codex-micro/adapters/claude-code.sh" }] }]
  }
}
```

### opencode

No adapter needed — `codex-micro setup` links the plugin, which uses the SDK
directly for permissions and prompt insertion.

### Anything else

Point the agent's equivalent hooks at the matching `adapters/<agent>.sh`, or
call the CLI directly:

```sh
echo '{"hook_event_name":"Stop","session_id":"abc","cwd":"'"$PWD"'"}' \
  | codex-micro event --agent my-agent
```

Check it landed with `codex-micro sessions`.

## Testing status

| Adapter | Status |
| --- | --- |
| `opencode` (plugin) | verified on hardware |
| `claude-code.sh` | event contract tested; hook config not verified against a live Claude Code |
| all others | generated from peon-ping's adapter list, **untested** |

The untested ones are thin enough that the likely failure is a wrong hook name
or payload field, not broken logic. `codex-micro sessions` after triggering a
hook will show immediately whether it worked.
