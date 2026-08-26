#!/bin/sh
# codex-micro adapter for: kiro-ide
#
# Usage in the agent's hook config:
#     /path/to/adapters/kiro-ide.sh [EventName]
#
# The event may come from the payload (hook_event_name) or as $1; agent-specific
# names such as AfterAgent/BeforeAgent are mapped in src/event.js.
. "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/_lib.sh"
codex_micro_forward "kiro-ide" "$@"
