# opencode-codex-micro

Turn a **Work Louder Codex Micro** (or **Creator Micro 2**) into a status
display and control surface for your coding agents: per-session status LEDs,
physical approve/deny, a YOLO auto-approve key, and hold-to-talk dictation.

Each agent session claims one of the six translucent Agent keys and colours it
with that session's live state. Pressing a key jumps to that session's Ghostty
tab.

Works with **any agent that can run a command on an event** —
[opencode](https://opencode.ai) (deepest integration, via its plugin API),
Claude Code, Codex, Gemini CLI, Cursor, Copilot, and ~15 more via thin
adapters. See [docs/adapters.md](docs/adapters.md).

| State | Colour | Effect |
| --- | --- | --- |
| idle / done | green | solid |
| busy | blue | shallow breath |
| needs approval | amber | shallow breath |
| error | red | solid |

| Key | Default | Action |
| --- | --- | --- |
| ✓ | `ACT07` | approve the focused session's permission prompt |
| ✗ | `ACT08` | deny it |
| YOLO | `ACT06` | auto-approve everything for 15 min (board turns red) |
| wide key | `ACT10`+`ACT11` | hold-to-talk dictation into the prompt |

## Requirements

- macOS (Apple Silicon or Intel)
- A Codex Micro / Creator Micro 2 on firmware **≥ 0.6.0**, connected by USB
- Node 18+
- Ghostty (for tab mapping and focus)
- Optional, for dictation: `brew install whisper-cpp sox`

## Supported agents

| Feature | opencode | Other agents |
| --- | --- | --- |
| Status LEDs, key → focus tab | ✅ | ✅ |
| ✓/✗ approve-deny, YOLO | ✅ API | ⚠️ keystroke fallback |
| Dictation insert | ✅ API | ⚠️ clipboard paste |

Only the opencode path is hardware-verified; the other adapters are documented
as untested in [docs/adapters.md](docs/adapters.md).

## Install

```sh
git clone https://github.com/RobbieTheWagner/opencode-codex-micro
cd opencode-codex-micro
npm install
./bin/codex-micro setup
./bin/codex-micro doctor
```

`setup` links the plugin into `~/.config/opencode/plugins/`, backs up and
rewrites the device keymap (**with a confirmation prompt and a diff**),
downloads the whisper model, and installs the LaunchAgents.

### Manual steps macOS will not let us script

- **Input Monitoring** → System Settings → Privacy & Security → Input
  Monitoring → add your node binary (`doctor` prints the path).
- **Accessibility** → same pane → needed to read Ghostty tab order.
- **Restart running opencode sessions** so they load the plugin.

Microphone access is *not* granted to a binary — see below.

## How it works

```
opencode plugin  ──▶  state/slots.json  ──▶  daemon  ──▶  HID
  (state only)        pid/title/state       (sole LED writer)
```

The plugin never touches HID. opencode can `SIGKILL` a plugin process, and a
dying process cannot complete an async HID write, so any "turn my own LED off
on exit" design eventually strands a key lit. The daemon instead expires
sessions by pid liveness and heartbeat age, so crashes self-heal in ~2 s.

**Slots follow Ghostty tab order**, recomputed continuously: the first six tabs
running opencode get slots 0–5, other tabs are skipped for numbering, and
focusing uses absolute tab position. Move a tab and the lights re-map.

### Why the agent keys need a keymap write

Per-key agent lighting is **keycode-gated, not layer-gated**: it renders on any
key whose keycode is `KV_OAI_AG00`..`AG05`, on any layer. Work Louder Input
does not expose those private keycodes and will silently strip them if you edit
the layer in the app, so they are written over RPC. Backups are taken first and
`codex-micro restore` reverts.

### Why dictation runs in the plugin

Under launchd the daemon has **no Microphone permission**, and macOS returns a
*silent stream* rather than an error. The Microphone pane has no `+` button, so
that binary cannot be granted access manually. The plugin runs under
opencode → Ghostty, which does have mic access.

Audio is captured with `sox` (which follows the macOS default input) and
transcribed by a warm `whisper-server` over HTTP (~0.1 s), then streamed into
the prompt with `client.tui.appendPrompt()`. Text is only emitted once two
consecutive transcriptions agree on it, because whisper revises freely.

## Commands

```sh
codex-micro doctor                  # check every prerequisite
codex-micro keys --actions          # write vendor keycodes to a user layer
codex-micro backup / restore        # device keymap
codex-micro services restart        # daemon + whisper server
codex-micro effects 4 6             # compare lighting effects by eye
codex-micro mic --list              # audio capture devices
codex-micro uninstall               # remove services + plugin link
```

State (slots, backups, logs, model) lives in
`~/.local/state/opencode-codex-micro`.

## Gotchas

- **Plugin changes only apply to sessions started afterwards.**
- **Don't edit the agent layer in Work Louder Input** — it strips the vendor
  keycodes. Re-run `codex-micro keys` if lights stop working.
- **Don't hand-edit the LaunchAgent plists.** Changing a plist makes macOS
  re-evaluate the job and revoke its Input Monitoring grant; writes then fail
  with `(iokit/common) not permitted`.
- ChatGPT desktop re-pushes its own lighting every 35–40 s and will fight the
  daemon. Quit it for clean behaviour.
- Bluetooth headsets must be connected **to this Mac** to be usable as a mic;
  an idle device yields silence, not an error.
- More than six opencode tabs: extras run unlit rather than stealing a key.

## Credits

Built on [`honest-andy/cm2-agent-keys`](https://github.com/honest-andy/cm2-agent-keys)
(MIT) for the HID transport and protocol documentation. See [NOTICE.md](NOTICE.md).

Unofficial; not affiliated with OpenAI or Work Louder.

## License

[MIT](LICENSE)
