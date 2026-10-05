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
HUB="$(sed -n 's/.*"hub_dir": *"\([^"]*\)".*/\1/p' "$CONFIG")"; HUB="${HUB:-$HOME/dev/context-hub}"
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
[ "$turns" -ge 5 ] && [ "$lookups" -ge 1 ] || exit 0
: > "$marker"
model_args=()
[ -z "$MODEL" ] || model_args=(--model "$MODEL")
hub_rel="${HUB#/}"
CTX_REVIEW=1 nohup "$CLAUDE" -p --resume "$sid" "/ctx:promote --auto" "${model_args[@]}" \
  --max-turns 20 --max-budget-usd 0.50 --add-dir "$HUB" \
  --allowedTools "Bash(ctx *)" "Bash(git -C $HUB status*)" "Bash(git -C $HUB checkout -b promote/*)" \
    "Bash(git -C $HUB add entries/*)" "Bash(git -C $HUB commit *)" "Bash(git -C $HUB push -u origin promote/*)" \
    "Bash(gh pr create *)" "Bash(bash $HUB/scripts/validate.sh)" "Bash($HUB/scripts/validate.sh)" \
    "Read" "Edit(//$hub_rel/entries/**)" "Write(//$hub_rel/entries/**)" \
  --disallowedTools "Bash(gh api *)" "Bash(gh auth *)" "Bash(gh repo *)" "Bash(gh secret *)" "Bash(gh pr merge *)" \
    "Bash(git push --force*)" "Bash(git push -f*)" "Bash(git remote *)" "Bash(git reset *)" \
  > "$SESSIONS/$sid.review.log" 2>&1 < /dev/null &
exit 0
