# Notices and attribution

## Bundled third-party code

`vendor/cm2-agent-keys/` — © Andy Aitken, MIT licensed.
Source: https://github.com/honest-andy/cm2-agent-keys

Provides the HID transport (`src/device.js`) and the protocol documentation
(`PROTOCOL.md`) this project depends on. Included verbatim, with its LICENSE.

That project in turn credits `pingles/wlrgb` (HID framing, whole-strip
lighting) and `eliBenven/freemicro` (agent-key protocol notes).

## Protocol research

The vendor protocol was documented by several independent clean-room efforts,
notably `arthurcolle/codex-micro-open` and `thannous/claude-codex-micro`. This
project uses the *facts* of the format — constants, byte offsets, JSON field
names — and contains no vendor SDK code.

## Trademarks

"Codex Micro" is a product of OpenAI and Work Louder. "Creator Micro" is a
product of Work Louder. This project is unofficial and is not affiliated with,
endorsed by, or sponsored by OpenAI, Work Louder, or Anthropic. Those names are
used only to describe compatibility.
