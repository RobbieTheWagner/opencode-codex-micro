#!/usr/bin/env node
// wl-led-service: persistent bridge between the wl-bridge daemon and the
// Creator Micro 2, built on the clean-room cm2-agent-keys library.
//
// stdin  (JSON lines): {"threads":[{id,color,brightness,effect,speed}]}
//                      {"config":{"ambient":{...},"keys":{...}}}
// stdout (JSON lines): {"ready":true} on connect, {"press":N} on agent-key press
//
// Reconnects forever if the pad is unplugged; commands while disconnected are
// dropped (the daemon resends current state on {"ready":true}).
const { CM2 } = require("cm2-agent-keys");
const readline = require("readline");

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dev = null;

// die with the parent daemon — an orphaned service would hold the HID device
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!dev) return;
  try {
    const cmd = JSON.parse(line);
    if (cmd.threads) await dev.setThreads(cmd.threads);
    if (cmd.config) await dev.setZones(cmd.config);
  } catch (e) { out({ error: String(e.message || e) }); }
});

(async () => {
  for (;;) {
    let d = null;
    try {
      d = await CM2.open();
      d.on("key", (k) => {
        const m = /^AG(\d+)$/.exec(k.key || "");
        if (m && k.act === 1) out({ press: Number(m[1]) });
      });
      d.on("error", () => {});
      await d.version(); // proves the RPC channel is alive
      dev = d;
      out({ ready: true });
      for (;;) { await sleep(15000); await d.version(); } // liveness probe
    } catch (e) {
      if (dev) out({ disconnected: true });
      dev = null;
      try { d && d.close(); } catch (_) {}
      await sleep(4000);
    }
  }
})();
