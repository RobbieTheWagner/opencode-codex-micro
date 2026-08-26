#!/bin/sh
# Shared adapter helper.
#
# Adapters are deliberately trivial: forward the agent's hook payload to
# `codex-micro event`, which normalizes event names and field spellings.
#
# A hook that fails can break the host agent, so this never exits non-zero and
# never blocks: no output, no prompts, always exit 0.

codex_micro_forward() {
    agent="$1"
    shift
    event="${1:-}"

    here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
    cli="$here/../bin/codex-micro"
    [ -x "$cli" ] || cli="$(command -v codex-micro 2>/dev/null)"
    [ -n "$cli" ] || exit 0

    if [ -n "$event" ]; then
        "$cli" event --agent "$agent" --event "$event" >/dev/null 2>&1 || true
    else
        "$cli" event --agent "$agent" >/dev/null 2>&1 || true
    fi
    exit 0
}
