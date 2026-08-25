#!/bin/bash
# Relay a Claude Code hook event to the wl-bridge daemon. Never blocks, never fails
# (a dead daemon must not break Claude Code). ITERM_SESSION_ID rides in a header;
# over ssh it arrives as LC_ITERM_SESSION_ID (SendEnv-forwarded, no sshd change).
SID="${ITERM_SESSION_ID:-$LC_ITERM_SESSION_ID}"
curl -s -m 1 -X POST "http://127.0.0.1:8377/hook" \
  -H "Content-Type: application/json" \
  -H "X-Iterm-Session: ${SID}" \
  --data-binary @- >/dev/null 2>&1
exit 0
