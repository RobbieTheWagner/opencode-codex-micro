import { expect, test } from "bun:test"

const { hostAppFromPs } = require("../src/herdr.js")

const ps = (...rows: string[]) => rows.join("\n") + "\n"

test("finds the terminal app hosting a herdr client", () => {
  const out = ps(
    " 1804     1 /Applications/Ghostty.app/Contents/MacOS/ghostty",
    " 1873     1 /opt/homebrew/opt/herdr/bin/herdr",
    " 3717  1804 /usr/bin/login",
    " 3718  3717 -/opt/homebrew/bin/fish",
    " 3751  3718 herdr",
  )
  expect(hostAppFromPs(out)).toBe("/Applications/Ghostty.app")
})

test("is terminal-agnostic", () => {
  const out = ps(
    "  500     1 /Applications/iTerm.app/Contents/MacOS/iTerm2",
    "  510   500 /usr/bin/login",
    "  520   510 -zsh",
    "  530   520 /opt/homebrew/bin/herdr",
  )
  expect(hostAppFromPs(out)).toBe("/Applications/iTerm.app")
})

test("handles app paths containing spaces", () => {
  const out = ps(
    "  500     1 /Applications/My Term.app/Contents/MacOS/myterm",
    "  520   500 -zsh",
    "  530   520 herdr",
  )
  expect(hostAppFromPs(out)).toBe("/Applications/My Term.app")
})

test("ignores the daemonised herdr server", () => {
  const out = ps(
    " 1804     1 /Applications/Ghostty.app/Contents/MacOS/ghostty",
    " 1873     1 /opt/homebrew/opt/herdr/bin/herdr",
  )
  expect(hostAppFromPs(out)).toBeNull()
})

test("returns null when no client is attached", () => {
  expect(hostAppFromPs(ps(" 1804     1 /Applications/Ghostty.app/Contents/MacOS/ghostty"))).toBeNull()
  expect(hostAppFromPs("")).toBeNull()
})

test("returns null when a client has no .app ancestor (e.g. over ssh)", () => {
  const out = ps(
    "  400     1 /usr/sbin/sshd",
    "  410   400 sshd: robbie@ttys001",
    "  420   410 -zsh",
    "  430   420 herdr",
  )
  expect(hostAppFromPs(out)).toBeNull()
})

test("does not match processes merely named like herdr", () => {
  const out = ps(
    "  500     1 /Applications/Ghostty.app/Contents/MacOS/ghostty",
    "  520   500 -zsh",
    "  530   520 herdr-helper",
  )
  expect(hostAppFromPs(out)).toBeNull()
})

test("survives a ppid cycle without hanging", () => {
  const out = ps("  10    20 herdr", "  20    10 -zsh")
  expect(hostAppFromPs(out)).toBeNull()
})
