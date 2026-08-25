/**
 * Map opencode sessions to Agent-key slots by GHOSTTY TAB ORDER.
 *
 * Slots used to be claimed first-come-first-served by process start order,
 * which had nothing to do with tab position: reordering tabs or opening new
 * ones left the lights pointing at the wrong sessions.
 *
 * Instead we enumerate Ghostty's tabs (in order) via the accessibility API and
 * assign slot 0..5 to the first six tabs that are running opencode. Non-opencode
 * tabs are skipped for slot numbering but still counted for focusing, since
 * Cmd+N addresses ABSOLUTE tab position.
 *
 * Requires Accessibility permission (already needed for focused-window checks).
 */
const { execFileSync } = require("node:child_process")

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

/**
 * Assign slots to live claims following tab order.
 *
 * @param {Array} claims live claims (pid, title, dir, ...)
 * @returns {{ assignment: Map<number, {slot:number, tabIndex:number, tabTitle:string}>, tabs: Array, unmatched: Array }}
 */
function assignSlots(claims) {
  const tabs = ghosttyTabs()
  const ocTabs = tabs.filter((t) => isOpencodeTab(t.title))
  const assignment = new Map()
  const remaining = [...claims]

  let slot = 0
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
    assignment.set(claim.pid, { slot, tabIndex: tab.index, tabTitle: tab.title })
    slot++
  }

  // Sessions we could not tie to a tab still get a light, after the matched
  // ones, so they are never invisible.
  for (const c of remaining) {
    if (slot >= SLOTS) break
    assignment.set(c.pid, { slot, tabIndex: null, tabTitle: null })
    slot++
  }

  return { assignment, tabs, unmatched: remaining }
}

module.exports = { assignSlots, ghosttyTabs, isOpencodeTab, titleMatches, normTitle, SLOTS }
