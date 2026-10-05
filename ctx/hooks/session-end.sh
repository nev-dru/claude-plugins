#!/usr/bin/env bash
# SessionEnd hook: when the user opted in (ctx config auto-promote on), re-enter the closed session
# headless and run the session review. Must return within 1.5 s, so it only gates and spawns.
set -euo pipefail
[ -z "${CTX_REVIEW:-}" ] || exit 0                                   # never inside a review run
CONFIG="${CTX_CONFIG:-$HOME/.config/ctx/config.json}"
SESSIONS="${CTX_SESSIONS_DIR:-$HOME/.config/ctx/sessions}"
CLAUDE="${CTX_CLAUDE_BIN:-claude}"
[ -f "$CONFIG" ] && grep -q '"auto_promote": *true' "$CONFIG" || exit 0
input="$(cat)"
sid="$(printf '%s' "$input" | sed -n 's/.*"session_id": *"\([^"]*\)".*/\1/p')"
transcript="$(printf '%s' "$input" | sed -n 's/.*"transcript_path": *"\([^"]*\)".*/\1/p')"
[ -n "$sid" ] && [ -f "$transcript" ] || exit 0
mkdir -p "$SESSIONS"
marker="$SESSIONS/$sid.reviewed"
[ ! -e "$marker" ] || exit 0
turns=$(grep -c '"type":"user"' "$transcript" || true)
lookups=$(grep -c -E 'ctx (search|get) ' "$transcript" || true)
[ "$turns" -ge 5 ] && [ "$lookups" -ge 1 ] || exit 0
: > "$marker"
CTX_REVIEW=1 nohup "$CLAUDE" -p --resume "$sid" "/ctx:promote --auto" --max-turns 15 --max-budget-usd 0.50 \
  --allowedTools "Bash(ctx *)" "Bash(git *)" "Bash(gh *)" "Bash(scripts/validate.sh)" Read Write Edit \
  > "$SESSIONS/$sid.review.log" 2>&1 < /dev/null &
exit 0
