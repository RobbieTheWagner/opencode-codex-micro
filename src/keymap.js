/**
 * Device keymap operations: backup, restore, and installing the vendor
 * KV_OAI_* keycodes onto a user layer.
 *
 * Per-key agent lighting is KEYCODE-gated, not layer-gated: it renders on any
 * key whose keymap keycode is KV_OAI_AG00..AG05, on any layer. That is why we
 * write those codes onto the user layer rather than trying to use layer 1.
 *
 * Work Louder Input does not know these keycodes and will silently strip them
 * if you edit that layer in the app, so this is done over RPC.
 */
const fs = require("node:fs")
const path = require("node:path")
const HID = require("node-hid")
const P = require("./paths.js")
const { CM2 } = require("../vendor/cm2-agent-keys/src/device.js")

const VID = 0x303a
const PID = 0x8360 // Codex Micro / Creator Micro 2
const USAGE_PAGE = 0xff00

const AGENT_ROWS = {
  0: ["KV_OAI_AG00", "KV_OAI_AG01"],
  1: ["KV_OAI_AG02", "KV_OAI_AG03", "KV_OAI_AG04", "KV_OAI_AG05"],
}
const ACTION_ROWS = {
  2: ["KV_OAI_ACT06", "KV_OAI_ACT07", "KV_OAI_ACT08", "KV_OAI_ACT09"],
  3: ["KV_OAI_ACT10", "KV_OAI_ACT11", "KV_OAI_ACT12"],
}

/** Locate the Codex Micro specifically -- never another Work Louder device. */
function devicePath() {
  const d = HID.devices().find(
    (x) => x.vendorId === VID && x.productId === PID && x.usagePage === USAGE_PAGE,
  )
  if (!d) throw new Error("Codex Micro (303a:8360) not found — is it connected over USB?")
  return d.path
}

async function open() {
  return CM2.open(devicePath())
}

const flat = (layer) => (layer.layout?.keymap || []).flat()

function activeProfile(km) {
  return km.profiles.find((p) => p.id === km.activeProfileId) || km.profiles[0]
}

/** The protected layer shipped with the vendor keycodes. */
function vendorLayer(profile) {
  return profile.layers.find((L) => flat(L).includes("KV_OAI_AG00"))
}

async function backup(dev) {
  const km = await dev.readKeymap()
  const layers = km.profiles.flatMap((p) => p.layers)
  if (!layers.some((L) => flat(L).includes("KV_OAI_AG00"))) {
    throw new Error("validation failed: no layer contains KV_OAI_AG00 (wrong device?)")
  }
  P.ensureDirs()
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")
  const file = path.join(P.BACKUP_DIR, `keymap-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(km, null, 2))

  // a backup you have not re-read is not a backup
  const rt = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!rt.profiles?.length) throw new Error("backup failed re-validation")
  return { file, keymap: km }
}

async function restore(dev, file) {
  const km = JSON.parse(fs.readFileSync(file, "utf8"))
  const layers = km.profiles.flatMap((p) => p.layers)
  const n = flat(layers[0]).length
  if (n !== 13) throw new Error(`backup has ${n} keys per layer, expected 13 (wrong device?)`)
  await dev.writeKeymap(km)
  await new Promise((r) => setTimeout(r, 700))
  return dev.readKeymap()
}

/**
 * Write vendor keycodes onto the target layer.
 * Returns { before, after } for display/confirmation. Never touches layer 1.
 */
async function planKeys(dev, { targetLayerId, actions }) {
  const km = await dev.readKeymap()
  const profile = activeProfile(km)
  const source = vendorLayer(profile)
  if (!source) throw new Error("could not find the protected vendor layer")

  const target = profile.layers.find((L) => L.id === targetLayerId)
  if (!target) throw new Error(`no layer with id=${targetLayerId}`)
  if (target.id === source.id) throw new Error("refusing to modify the protected vendor layer")

  const before = target.layout.keymap.map((r) => [...r])
  const rows = { ...AGENT_ROWS, ...(actions ? ACTION_ROWS : {}) }
  for (const [idx, codes] of Object.entries(rows)) {
    const row = target.layout.keymap[Number(idx)]
    if (!row) throw new Error(`target layer has no row ${idx}`)
    if (row.length !== codes.length) {
      throw new Error(`row ${idx} has ${row.length} keys, expected ${codes.length}`)
    }
    for (let i = 0; i < codes.length; i++) row[i] = codes[i]
  }
  return { km, target, source, before, after: target.layout.keymap.map((r) => [...r]) }
}

async function commitKeys(dev, km, targetLayerId) {
  await dev.writeKeymap(km)
  await new Promise((r) => setTimeout(r, 700))
  const rb = await dev.readKeymap()
  const t = activeProfile(rb).layers.find((L) => L.id === targetLayerId)
  const got = flat(t)
  const want = [...AGENT_ROWS[0], ...AGENT_ROWS[1]]
  return { ok: want.every((k) => got.includes(k)), keys: got }
}

/** Candidate user layers (everything except the protected vendor layer). */
async function layers(dev) {
  const km = await dev.readKeymap()
  const profile = activeProfile(km)
  const source = vendorLayer(profile)
  return profile.layers.map((L) => ({
    id: L.id,
    name: L.name,
    keys: flat(L),
    protectedLayer: source ? L.id === source.id : false,
  }))
}

module.exports = { open, backup, restore, planKeys, commitKeys, layers, devicePath, VID, PID }
