#!/usr/bin/env bash
# SessionEnd hook: when the user opted in (ctx config auto-promote on), re-enter the closed session
# headless and run the session review. Must return within 1.5 s, so it only gates and spawns.
# The spawned run gets the narrowest tool set that can draft entries and open one draft PR in the hub.
set -euo pipefail
[ -z "${CTX_REVIEW:-}" ] || exit 0                                   # never inside a review run
CONFIG="${CTX_CONFIG:-$HOME/.config/ctx/config.json}"
SESSIONS="${CTX_SESSIONS_DIR:-$HOME/.config/ctx/sessions}"
CLAUDE="${CTX_CLAUDE_BIN:-claude}"
[ -f "$CONFIG" ] && grep -q '"auto_promote": *true' "$CONFIG" || exit 0
MODEL="$(sed -n 's/.*"review_model": *"\([^"]*\)".*/\1/p' "$CONFIG")"
input="$(cat)"
sid="$(printf '%s' "$input" | sed -n 's/.*"session_id": *"\([^"]*\)".*/\1/p')"
transcript="$(printf '%s' "$input" | sed -n 's/.*"transcript_path": *"\([^"]*\)".*/\1/p')"
[[ "$sid" =~ ^[A-Za-z0-9_-]+$ ]] && [ -f "$transcript" ] || exit 0
mkdir -p "$SESSIONS"
marker="$SESSIONS/$sid.reviewed"
[ ! -e "$marker" ] || exit 0
# User turns exclude tool results (also "user" rows); lookups are real ctx commands, not pointer text.
turns=$(grep '"type":"user"' "$transcript" | grep -vc '"tool_result"' || true)
lookups=$(grep -c -E '"command": *"ctx (search|get) ' "$transcript" || true)
[ "$turns" -ge "${CTX_MIN_TURNS:-5}" ] && [ "$lookups" -ge 1 ] || exit 0   # CTX_MIN_TURNS: test knob only
: > "$marker"
model_args=()
[ -z "$MODEL" ] || model_args=(--model "$MODEL")
PROMOTE="$HOME/.config/ctx/promote"; mkdir -p "$PROMOTE"
promote_rel="${PROMOTE#/}"
# All hub writes go through bin/ctx-promote, which validates its arguments and refuses to push to main
# when CTX_REVIEW is set. Raw git and gh are denied outright. CTX_NO_PERSONAL keeps the personal layer
# (Claude memory, personal notes, the project map) out of this run, whose output becomes a hub PR.
CTX_REVIEW=1 CTX_NO_PERSONAL=1 nohup "$CLAUDE" -p --resume "$sid" "/ctx:promote --auto" ${model_args[@]+"${model_args[@]}"} \
  --max-turns 25 --max-budget-usd 0.50 --add-dir "$PROMOTE" \
  --allowedTools "Bash(ctx *)" "Bash(ctx-promote *)" "Bash(date *)" "Read" "Edit(//$promote_rel/**)" \
  --disallowedTools "Bash(git *)" "Bash(gh *)" "Bash(ctx sync *)" "Bash(ctx config *)" "Bash(ctx local *)" "Bash(ctx-promote publish * main*)" \
  > "$SESSIONS/$sid.review.log" 2>&1 < /dev/null &
exit 0
