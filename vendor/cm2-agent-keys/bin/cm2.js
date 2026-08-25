#!/usr/bin/env node
"use strict";
const fs = require("fs");
const { CM2, Effect } = require("../src/device.js");

const USAGE = `cm2 — control a Work Louder Creator Micro 2's agent-key LEDs

  cm2 status                         firmware, battery, active profile/layer
  cm2 listen                         print key/joystick events (Ctrl-C to stop)
  cm2 threads <id:color[:effect]>…   per-key lighting, e.g. cm2 threads 0:ff0000 1:00ff00:breath
  cm2 zones <ambient> <keys>         zone lighting as effect,color,brightness  e.g. breath,5e5ce6,0.2 off,0,0
  cm2 glow <effect> <color> [b] [s]  whole-strip preview (works on stock firmware)
  cm2 keymap                         print the device keymap
  cm2 backup <file>                  save the keymap to a file
  cm2 restore <file>                 write a saved keymap back to the device
  cm2 agent-row <row> [count]        rewrite a keymap row to agent keycodes (AG00..)
  cm2 bootloader                     reboot into the bootloader (for esptool flashing)

Per-key lighting and events need firmware >= v0.6.0-rc. See README.`;

function parseSide(spec) {
  const [effect, color, brightness] = spec.split(",");
  return { effect, color: parseInt(color, 16), brightness: Number(brightness ?? 1),
           speed: 0.5, magic: 0 };
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(USAGE); process.exit(0); }
  const d = await CM2.open();

  switch (cmd) {
    case "status":
      console.log(JSON.stringify(await d.status(), null, 2));
      break;
    case "listen":
      console.log("listening — press keys / move the joystick (Ctrl-C to stop)");
      d.on("key", (k) => console.log("key", JSON.stringify(k)));
      d.on("joystick", (j) => console.log("joystick", JSON.stringify(j)));
      await new Promise(() => {});
      break;
    case "threads": {
      const threads = args.map((a) => {
        const [id, color, effect = "solid"] = a.split(":");
        return { id: Number(id), color: parseInt(color, 16), brightness: 1,
                 effect, speed: 0.5 };
      });
      console.log(JSON.stringify(await d.setThreads(threads)));
      break;
    }
    case "zones":
      console.log(JSON.stringify(await d.setZones({
        ambient: parseSide(args[0]), keys: parseSide(args[1] || args[0]) })));
      break;
    case "glow": {
      const [effect = "solid", color = "0A84FF", b = "0.7", s = "0.5"] = args;
      const side = { effect, brightness: Number(b), speed: Number(s), magic: 0,
                     color: parseInt(color.replace("#", ""), 16) };
      await d.preview({ backlight: side, underglow: side });
      console.log("ok");
      break;
    }
    case "keymap":
      console.log(JSON.stringify(await d.readKeymap(), null, 2));
      break;
    case "backup": {
      const km = await d.readKeymap();
      fs.writeFileSync(args[0], JSON.stringify(km, null, 1));
      console.log("saved", args[0]);
      break;
    }
    case "restore": {
      const km = JSON.parse(fs.readFileSync(args[0], "utf8"));
      await d.writeKeymap(km);
      console.log("restored — keys apply live");
      break;
    }
    case "agent-row": {
      const row = Number(args[0]);
      const count = Number(args[1] || 0);
      const km = await d.readKeymap();
      const layer = km.profiles[0].layers[0];
      const keys = layer.layout.keymap[row];
      if (!keys) throw new Error(`no keymap row ${row}`);
      const n = count || keys.length;
      console.log("row before:", JSON.stringify(keys));
      for (let i = 0; i < n && i < keys.length && i < 6; i++)
        keys[i] = `KV_OAI_AG${String(i).padStart(2, "0")}`;
      await d.writeKeymap(km);
      console.log("row after: ", JSON.stringify(keys));
      console.log("these keys now emit events instead of keystrokes — run `cm2 listen`");
      break;
    }
    case "bootloader":
      await d.enterBootloader().catch(() => {});
      console.log("device entering bootloader — flash with esptool, then power-cycle");
      break;
    default:
      console.error("unknown command:", cmd);
      console.log(USAGE);
      process.exit(1);
  }
  d.close();
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
