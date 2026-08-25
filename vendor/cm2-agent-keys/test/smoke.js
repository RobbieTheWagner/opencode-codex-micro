#!/usr/bin/env node
// Live smoke test — needs a Creator Micro 2 attached (USB or Bluetooth).
const { CM2 } = require("../src/device.js");
(async () => {
  const devs = CM2.list();
  console.log("devices:", devs.length);
  const d = await CM2.open();
  console.log("version:", JSON.stringify(await d.version()));
  console.log("status:", JSON.stringify(await d.status()));
  console.log("thstatus:", JSON.stringify(
    await d.setThreads([{ id: 5, color: 0x00ff00, brightness: 1, effect: "solid", speed: 0.5 }])));
  console.log("fs.list:", JSON.stringify(await d.listFiles()).slice(0, 150));
  d.close();
  console.log("SMOKE TEST PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
