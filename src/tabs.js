/**
 * Map agent sessions to Agent-key slots by TAB ORDER.
 *
 * Slots used to be claimed first-come-first-served by process start order,
 * which had nothing to do with tab position: reordering tabs or opening new
 * ones left the lights pointing at the wrong sessions.
 *
 * Two backends, chosen per call:
 *
 *   herdr    Preferred. Sessions run inside herdr panes and report their own
 *            HERDR_PANE_ID, so matching is an exact id lookup against
 *            `herdr agent list` and focusing addresses the pane directly.
 *   ghostty  Fallback for sessions in bare Ghostty tabs. Enumerates tabs in
 *            order via the accessibility API and matches them to sessions by
 *            comparing truncated tab titles, which is inherently fuzzy.
 *            Requires Accessibility permission.
 *
 * Both can be live at once (some sessions in herdr, some in plain Ghostty
 * tabs); herdr-backed sessions are assigned first so their slots stay stable
 * regardless of what the flakier Ghostty query returns.
 */
const { execFileSync } = require("node:child_process")
const herdr = require("./herdr.js")

const SLOTS = 6

const TAB_SCRIPT = `tell application "System Events" to tell process "Ghostty"
  set out to ""
  repeat with w in windows
    try
      repeat with tg in (tab groups of w)
        repeat with t in (radio buttons of tg)
          set out to out & (title of t) & "\\n"
        end repeat
      end repeat
    end try
  end repeat
  if out is "" then
    repeat with w in windows
      set out to out & (name of w) & "\\n"
    end repeat
  end if
  return out
end tell`

/**
 * Ordered Ghostty tab titles, 1-based absolute index.
 *
 * The accessibility query intermittently fails or returns a partial list (for
 * example while a window is being created). Reporting that as truth made slot
 * assignments flap between ticks, and every flap repainted all six keys,
 * restarting their animations mid-fade. So: cache the last good result and
 * never regress to an empty list.
 */
let cachedTabs = []
let cachedAt = 0
const CACHE_TTL_MS = 15000

function ghosttyTabs() {
  let tabs = []
  try {
    const out = execFileSync("osascript", ["-e", TAB_SCRIPT], { encoding: "utf8", timeout: 4000 })
    tabs = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((title, i) => ({ index: i + 1, title }))
  } catch {
    tabs = []
  }

  const fresh = Date.now() - cachedAt < CACHE_TTL_MS
  if (!tabs.length && fresh) return cachedTabs

  if (tabs.length) {
    cachedTabs = tabs
    cachedAt = Date.now()
  }
  return tabs
}

const isOpencodeTab = (title) => /^OC\s*\|/i.test(title) || title.trim() === "OpenCode"

/** Strip decoration so tab titles and session titles can be compared. */
function normTitle(s) {
  return String(s || "")
    .replace(/^OC\s*\|\s*/i, "")
    .replace(/\u2026|\.\.\.$/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .trim()
    .toLowerCase()
}

function titleMatches(tabTitle, sessionTitle) {
  const a = normTitle(tabTitle)
  const b = normTitle(sessionTitle)
  if (!a && !b) return true
  if (!a || !b) return false
  // tab titles are truncated, so prefix matching in either direction
  return a === b || a.startsWith(b) || b.startsWith(a)
}

/** Pane id a claim recorded for itself, if it was running inside herdr. */
const paneOf = (c) => (c && c.herdr && c.herdr.paneId) || null

/**
 * Assign slots to claims running in herdr panes, following herdr's own agent
 * order.
 *
 * Primary matching is by pane id: the session wrote its own HERDR_PANE_ID into
 * the claim, so a pane either is that session or is not — no fuzziness.
 *
 * Secondary matching is by title, for sessions whose agent integration cannot
 * report a pane id (a shell-hook adapter, or an opencode session still running
 * a plugin build from before pane reporting existed). It reuses the same
 * truncation-tolerant comparison as the Ghostty path and is strictly a
 * fallback, so upgrading a session only ever makes its slot more stable.
 *
 * @returns {{ assigned: Map, remaining: Array, nextSlot: number, panes: Array }}
 */
function assignHerdrSlots(claims, startSlot = 0, log = null) {
  const assigned = new Map()
  const remaining = [...claims]
  let slot = startSlot

  if (!herdr.available()) return { assigned, remaining, nextSlot: slot, panes: [] }

  const panes = herdr.agents(log)

  // Resolve pane -> claim BEFORE assigning any slot numbers, so slots can then
  // be handed out in strict pane order regardless of how each match was made.
  //
  // Id matching is resolved across all panes first: a claim that knows its own
  // pane must never be stolen by some other pane's title guess.
  const byId = new Map()
  for (const pane of panes) {
    const claim = remaining.find((c) => paneOf(c) === pane.pane_id)
    if (claim) byId.set(pane.pane_id, claim)
  }

  const claimed = new Set(byId.values())
  const matched = new Map(byId)
  for (const pane of panes) {
    if (matched.has(pane.pane_id)) continue
    const title = pane.terminal_title_stripped || pane.terminal_title
    const claim = remaining.find(
      (c) => !claimed.has(c) && !paneOf(c) && c.title && titleMatches(title, c.title),
    )
    if (!claim) continue
    matched.set(pane.pane_id, claim)
    claimed.add(claim)
  }

  for (const pane of panes) {
    if (slot >= SLOTS) break
    const claim = matched.get(pane.pane_id)
    if (!claim) continue
    remaining.splice(remaining.indexOf(claim), 1)
    assigned.set(claim.pid, {
      slot,
      backend: "herdr",
      paneId: pane.pane_id,
      tabId: pane.tab_id,
      workspaceId: pane.workspace_id,
      tabIndex: null,
      tabTitle: pane.terminal_title || null,
    })
    slot++
  }

  return { assigned, remaining, nextSlot: slot, panes }
}

/**
 * Assign slots to live claims following tab order.
 *
 * @param {Array} claims live claims (pid, title, dir, ...)
 * @param {Function} [log] optional logger, used to explain a herdr fallback
 * @returns {{ assignment: Map<number, object>, tabs: Array, unmatched: Array }}
 */
function assignSlots(claims, log = null) {
  // herdr first: exact id matches, so these slots never move because the
  // Ghostty accessibility query returned something odd this tick.
  const h = assignHerdrSlots(claims, 0, log)
  const assignment = h.assigned
  let remaining = h.remaining
  let slot = h.nextSlot

  // Ghostty fallback, for any session not accounted for by herdr. Skip the
  // osascript round-trip entirely when there is nothing left to match.
  let tabs = []
  if (remaining.length && slot < SLOTS) {
    tabs = ghosttyTabs()
    const ocTabs = tabs.filter((t) => isOpencodeTab(t.title))

    for (const tab of ocTabs) {
      if (slot >= SLOTS) break

      // prefer a titled match; fall back to an untitled session for a bare
      // "OpenCode" tab (a session that has not been named yet)
      let idx = remaining.findIndex((c) => c.title && titleMatches(tab.title, c.title))
      if (idx === -1 && normTitle(tab.title) === "opencode") {
        idx = remaining.findIndex((c) => !c.title)
      }
      if (idx === -1) continue

      const claim = remaining.splice(idx, 1)[0]
      assignment.set(claim.pid, {
        slot,
        backend: "ghostty",
        paneId: null,
        tabIndex: tab.index,
        tabTitle: tab.title,
      })
      slot++
    }
  }

  // Sessions we could not tie to a tab still get a light, after the matched
  // ones, so they are never invisible.
  for (const c of remaining) {
    if (slot >= SLOTS) break
    assignment.set(c.pid, { slot, backend: null, paneId: null, tabIndex: null, tabTitle: null })
    slot++
  }

  return { assignment, tabs, panes: h.panes, unmatched: remaining }
}

module.exports = {
  assignSlots,
  assignHerdrSlots,
  ghosttyTabs,
  isOpencodeTab,
  titleMatches,
  normTitle,
  SLOTS,
}
