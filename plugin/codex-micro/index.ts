/**
 * codex-micro (OpenCode V2 server plugin).
 *
 * Runs inside the shared OpenCode service. Its only job is YOLO: while the pad
 * has it armed, permission requests are allowed before a prompt is ever shown.
 * Everything per-terminal (state, approve/deny keys, dictation) lives in tui.ts.
 */

import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

// The plugin directory is symlinked into OpenCode's config; resolve through the
// link so the repo's src/ modules are found.
const require_ = createRequire(fs.realpathSync(fileURLToPath(import.meta.url)))
const y = require_("../../src/yolo.js")

export default {
  id: "codex-micro",
  async setup(ctx: any) {
    await ctx.permission.hook("evaluate", (event: any) => {
      if (event.effect !== "ask") return
      try {
        if (!y.isActive()) return
      } catch {
        return
      }
      event.effect = "allow"
      const what = event.action || "permission"
      const resources = (event.resources ?? []).join(", ").slice(0, 120)
      y.audit(`AUTO-APPROVED ${what} :: ${resources} [${path.basename(ctx.location?.directory || "")}]`)
    })
  },
}
