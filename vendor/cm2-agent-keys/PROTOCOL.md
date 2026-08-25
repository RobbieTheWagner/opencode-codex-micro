# Creator Micro 2 vendor protocol

This is how host software talks to the Work Louder Creator Micro 2 (and the
OpenAI Codex Micro, which is the same hardware): JSON-RPC-ish messages inside
USB-HID or Bluetooth HID reports.

I worked this out by watching the device's wire behaviour and reading strings
in the publicly downloadable firmware images. There's no vendor source code in
this repo — method names and packet layouts are just facts about the device's
interface, written down so other people can interoperate with the thing they
bought.

Related reading: [freemicro's protocol doc](https://github.com/eliBenven/freemicro/blob/main/docs/PROTOCOL.md)
covers the same vendor channel as seen from a Codex Micro (fw v0.4.1),
including the other HID report IDs and a 63-byte unprefixed USB framing
variant. Notable difference on the CM2 with v0.6.0-rc: `v.oai.rgbcfg`
visibly drives the underglow ring and base backlight here, where their
Codex unit only ACKed it. What this doc adds is the keymap side — creating
agent keys on a device that didn't ship with them.

## Transport

The device (VID `0x303a` — it's ESP32-based — PID `0x8298`) exposes several HID
interfaces; the RPC channel is the one with **usage page `0xFF00`, usage `1`**.

macOS note: keyboard-class HID devices must be opened **non-exclusively**
(`kIOHIDOptionsTypeNone`); an exclusive open fails with `kIOReturnNotPrivileged`
(`0xE00002C1`). With node-hid: `HIDAsync.open(path, { nonExclusive: true })`.

### Framing

Messages are UTF-8 JSON lines carried in 64-byte HID reports:

| byte | meaning |
|---|---|
| 0 | report ID, always `0x06` |
| 1 | channel: `1` = debug text, `2` = RPC |
| 2 | payload length `n` (1–61) |
| 3…3+n | payload bytes |

Long messages span multiple reports; receivers accumulate payload per channel
and split on newlines. Non-ASCII characters are `\uXXXX`-escaped so the wire is
7-bit clean. Device→host reports use the same layout.

### Requests and responses

Requests are `{"method": "...", "params": ..., "id": N}` (no `jsonrpc` field).
Responses echo the id: `{"result": ..., "id": N, "method": "..."}` or
`{"error": {...}, "id": N}`.

Device-initiated notifications are id-less and — watch out — use
**abbreviated field names**: `{"m": "v.oai.hid", "p": {"k": "AG00", "act": 1}}`.
That's `m` for method, `p` for params, `k` for key. Responses spell
`method` out in full; notifications don't. This cost me an afternoon.

Two more traps for implementers:

- **Serialise your request writes.** The device accumulates one buffer per
  channel, so if two in-flight requests interleave their report chunks the
  device sees shredded JSON and answers with a stream of
  `{"error":{"code":400,"message":"JSON error - InvalidInput"}}`. One
  write-queue fixes it.
- **macOS: open non-exclusively** (see Transport above), or every open fails
  with what looks like a permissions problem and absolutely is not.

## Methods

### Stock (all recent firmware)

| method | params | notes |
|---|---|---|
| `sys.version` | – | firmware version |
| `sys.bootloader` | – | reboot into the serial bootloader |
| `sys.selftest` | – | |
| `device.status` | – | `{version, profile_index, layer_index, battery, is_charging}` |
| `lights.preview` | `{backlight:{effect,brightness,speed,magic,color}, underglow:{…}}` | whole-strip, realtime, never persisted. `effect` is a string here (`"solid"`, `"breath"`, …); brightness/speed 0–1; color is a packed RGB int |
| `fs.list` | `{path?, recursive?}` | list device files |
| `fs.read` | `{file}` | read a file (e.g. `keymap.json`) |
| `fs.write` | `{file, data}` | write a file — **applies live and persists** |
| `fs.delete`, `fs.rmdir`, `fs.txbegin`, `fs.txcommit`, `fs.readbin`, `fs.writebin` | | filesystem extras |
| `appmgr.list_active`, `appmgr.list_installed` | – | firmware app carousel |
| `ui.active_screen`, `ui.home_accent_color` | | on-device UI |
| `mp.write_info`, `mp.write_artwork` | | media-player screen |
| `host.focused_app` | | tell the device which desktop app has focus |

### Vendor "OAI bridge" (firmware ≥ v0.6.0-rc)

The firmware that powers the Codex Micro's Agent Keys. Its init log line —
`OAI BRIDGE: init, v.oai.thstatus registered on all variants` — is why this
works on a stock Creator Micro 2, not just the OpenAI edition.

| method | direction | payload |
|---|---|---|
| `v.oai.thstatus` | host→device | array of per-thread lighting: `{id, c, b, e, s, sk, sa}` — thread id 0–5, packed RGB int, brightness 0–1, effect int (below), speed 0–1, sync-keys / sync-ambient 0/1. Omitted fields keep their current value. |
| `v.oai.rgbcfg` | host→device | `{ambient: side, keys: side}` where side = `{effect, brightness, speed, magic, color}` (effect int, brightness/speed 0–1, packed RGB int). `ambient` = underglow ring, `keys` = base backlight of non-agent keys. |
| `v.oai.hid` | device→host | notification on agent/action key events: `{"key": "AG00", "act": 1}` (1 press, 0 release) |
| `v.oai.rad` | device→host | joystick position notifications |

Effect integers for the vendor methods: `0` off, `1` solid, `2` snake,
`3` rainbow, `4` breath, `5` gradient.

## Agent keys: the keymap side

Per-thread lighting only renders on keys whose **keymap keycode** is an agent
key. In `keymap.json` (readable/writable via `fs.read`/`fs.write`), set a key's
code to `KV_OAI_AG00` … `KV_OAI_AG05`; thread id *n* lights key `AGnn`.
`KV_OAI_ACT06` … `KV_OAI_ACT12` similarly exist for "action" keys.

Agent/action keys **stop sending normal keystrokes** — they emit `v.oai.hid`
notifications instead, so your host process handles presses itself.

Keymap writes apply live (no reboot) and persist to flash. **Always back up
first** (`cm2 backup my-keymap.json`); the official Input configurator doesn't
understand these keycodes and may overwrite them if you edit the layout there.

## Firmware

Public firmware images: `github.com/worklouder/cm-v2-fw-releases` (merged
ESP32 images). The OAI bridge appears in the v0.6.0-rc series. To flash:
`cm2 bootloader`, then `esptool --port /dev/tty.usbmodem* write_flash 0x0
firmware_vX_merged.bin`, then power-cycle. Keymap and files survive flashing
(the image doesn't span the data partition), but back up anyway. USB only.
