/**
 * Compare lighting effects side by side on the six Agent keys.
 *
 * The firmware exposes: off=0 solid=1 snake=2 rainbow=3 breath=4 gradient=5
 * shallowBreath=6. We cannot observe what ChatGPT sends (host->device writes
 * are not broadcast; only the device's replies are), so pick by eye.
 *
 *   node scripts/codex-effects.js            # walk effects on all keys
 *   node scripts/codex-effects.js 4 6        # compare two effects at once
 *   node scripts/codex-effects.js speed 6    # sweep speeds for one effect
 */
const os = require("node:os")
const path = require("node:path")
const HID = require("node-hid")
const { CM2 } = require("../vendor/cm2-agent-keys/src/device.js")

const EFFECTS = { off: 0, solid: 1, snake: 2, rainbow: 3, breath: 4, gradient: 5, shallowBreath: 6 }
const NAME = Object.fromEntries(Object.entries(EFFECTS).map(([k, v]) => [v, k]))
const BLUE = 0x0a84ff

const hold = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const info = HID.devices().find(
    (d) => d.vendorId === 0x303a && d.productId === 0x8360 && d.usagePage === 0xff00,
  )
  if (!info) throw new Error("Codex Micro not connected")
  const dev = await CM2.open(info.path)

  const args = process.argv.slice(2)
  const all = [0, 1, 2, 3, 4, 5]

  if (args[0] === "speed") {
    const effect = Number(args[1] || 4)
    console.log(`\nSweeping speed for '${NAME[effect]}' (${effect}) — 6s each\n`)
    for (const speed of [0.2, 0.35, 0.5, 0.7, 0.9]) {
      console.log(`  speed ${speed}`)
      await dev.setThreads(all.map((id) => ({ id, color: BLUE, brightness: 1, effect, speed })))
      await hold(6000)
    }
  } else if (args.length >= 2) {
    const [a, b] = args.map(Number)
    console.log(`\nLEFT half = '${NAME[a]}' (${a})   RIGHT half = '${NAME[b]}' (${b})`)
    console.log("Watch which fades more smoothly. 20s.\n")
    await dev.setThreads([
      ...[0, 2, 3].map((id) => ({ id, color: BLUE, brightness: 1, effect: a, speed: 0.5 })),
      ...[1, 4, 5].map((id) => ({ id, color: BLUE, brightness: 1, effect: b, speed: 0.5 })),
    ])
    await hold(20000)
  } else {
    for (const [name, effect] of Object.entries(EFFECTS)) {
      if (name === "off") continue
      console.log(`  ${name} (${effect}) — 6s`)
      await dev.setThreads(all.map((id) => ({ id, color: BLUE, brightness: 1, effect, speed: 0.5 })))
      await hold(6000)
    }
  }

  console.log("\ndone — the daemon will repaint within ~60s")
  dev.close()
  process.exit(0)
})().catch((e) => {
  console.error("ERROR:", e.message || e)
  process.exit(1)
})
