# cm2-agent-keys

Per-key status lights and key-press events for the Work Louder Creator Micro 2,
from any process you like. In other words: the OpenAI Codex Micro's Agent Keys,
working on the standard device.

## The short version

OpenAI sell the [Codex Micro](https://worklouder.cc/codex-micro), a $230
limited-run macropad whose party trick is six frosted keys that glow with the
live status of your Codex threads. It's a modified
[Creator Micro 2](https://worklouder.cc/creator-micro-2), which costs a fair
bit less and isn't sold out. I bought one, wanted the same lights for my
Claude Code sessions, and started digging.

It turns out the agent-key machinery ships in the standard CM2's firmware.
The boot log literally says so:

```
OAI BRIDGE: init, v.oai.thstatus registered on all variants
```

Two projects paved the way here and deserve credit:
[pingles/wlrgb](https://github.com/pingles/wlrgb) documented the HID framing
and whole-strip lighting, and [eliBenven/freemicro](https://github.com/eliBenven/freemicro)
documented the agent-key protocol itself — but for the Codex Micro, which
ships with its agent keys pre-configured. What was missing is the piece a
standard CM2 owner needs: how to *create* agent keys on a stock device.
That's the v0.6.0-rc firmware plus rewriting your keymap keycodes to
`KV_OAI_AG00`–`05` over RPC, both covered here. Alongside that, this repo is
a small Node library and CLI that gives you

- per-key RGB on up to six keys (thread lighting), plus the underglow ring and
  the base backlight as two more zones — all realtime
- key events: agent keys stop typing and instead tell *your* software they
  were pressed
- keymap read/write, whole-strip preview, status, bootloader entry
- one dependency (`node-hid`), USB or Bluetooth, no vendor SDK

The protocol is documented in [PROTOCOL.md](PROTOCOL.md) so you can
reimplement it in whatever language you like.

I drive mine from Claude Code hooks: each key is a session — red when it's
blocked on a permission, breathing amber when it asked me something, blue
while it works, green when it's done — and pressing the key focuses that
session's iTerm2 pane. That whole setup is in
[`examples/claude-code/`](examples/claude-code/). But nothing here is
Claude-specific. Your "agents" can be CI jobs, deploys, on-call alerts,
whatever you want to glance at.

## You'll need

- A Creator Micro 2 (or Codex Micro) on **firmware v0.6.0-rc or newer**. The
  images are public at
  [worklouder/cm-v2-fw-releases](https://github.com/worklouder/cm-v2-fw-releases);
  flashing steps are in [PROTOCOL.md](PROTOCOL.md#firmware). It's prerelease
  firmware — mine's been fine, but that's your call to make.
- Node 18+. Developed and tested on macOS; node-hid supports Linux and
  Windows too, reports welcome.

## Quick start

```bash
git clone https://github.com/honest-andy/cm2-agent-keys && cd cm2-agent-keys
npm install

node bin/cm2.js status                  # is it alive? firmware, battery
node bin/cm2.js backup my-keymap.json   # do this first, seriously

# turn a row of keys into agent keys (they stop typing, start reporting)
node bin/cm2.js agent-row 1

# light them up
node bin/cm2.js threads 0:ff0000 1:ff9f0a:breath 2:30d058 3:0a84ff

# hear presses
node bin/cm2.js listen
```

## Library

```js
const { CM2 } = require("./src/device.js");

const pad = await CM2.open();

await pad.setThreads([
  { id: 0, color: 0xff0000, brightness: 1, effect: "solid" },   // key AG00
  { id: 1, color: 0xff9f0a, brightness: 1, effect: "breath" },  // key AG01
]);

await pad.setZones({
  ambient: { effect: "breath", color: 0x5e5ce6, brightness: 0.2, speed: 0.3, magic: 0 },
  keys:    { effect: "solid",  color: 0xffd9a6, brightness: 0.12, speed: 0.5, magic: 0 },
});

pad.on("key", ({ key, act }) => {
  if (act === 1) console.log(`${key} pressed`);
});
```

There's also `preview()` (whole-strip lighting, works on stock firmware),
`status()`, `readKeymap()`/`writeKeymap()`, file access, `enterBootloader()`,
and `joystick`/`notification`/`debug` events.

## Things that will bite you if you don't read this

- **Back up your keymap before `agent-row`.** It rewrites keycodes on the
  device, live. `cm2 restore` puts your backup back.
- The official **Input** configurator doesn't know the agent keycodes exist.
  Edit your layout in there and it may quietly remove them. Also close Input
  while your own software drives the LEDs, or they fight over the lighting.
- Vendor lighting is realtime and doesn't persist — the pad reverts to its
  stored lighting on power-cycles and profile reloads, so resync
  periodically (the example daemon does it every 30 seconds).
- Not affiliated with Work Louder or OpenAI. A future firmware could change
  any of this.

## License

MIT © Andy Aitken
