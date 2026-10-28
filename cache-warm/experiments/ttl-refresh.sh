#!/usr/bin/env bash
# Does a cache hit refresh an entry with the entry's TTL or the request's TTL?
#
# Two experiments, each in its own empty directory (the working directory is
# part of Claude Code's prefix, so they can't see each other's cache):
#
#   upgrade:  R1 writes a 5m entry → R2 (1h request) hits it at +60s
#             → wait past 5m → R3 hit means the hit refreshed it for 1h.
#   forward:  R1 writes a 1h entry → R2 (5m request) hits it at +56m
#             → R3 at +63m: hit means a 5m request refreshed the 1h entry
#             for an hour; a write means it refreshed for 5m or not at all.
#
# Reads usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens and
# cache_read_input_tokens from `claude -p --output-format json`.
#
# Usage: ttl-refresh.sh <upgrade|forward> <results.jsonl>   (model: haiku)
set -u
which="$1"; out="$2"
model="${MODEL:-haiku}"
dir="$(mktemp -d)"; cd "$dir"
prompt="Reply with exactly: OK"

run() { # run <label> [ENV=VAL ...]
  local label="$1"; shift
  local started; started=$(date +%s)
  local json
  json=$(env "$@" claude -p "$prompt" --output-format json --model "$model" 2>/dev/null)
  local ended; ended=$(date +%s)
  python3 -I - "$label" "$started" "$ended" "$out" <<'EOF' "$json"
import json, sys
label, started, ended, out = sys.argv[1:5]
raw = sys.argv[5]
try:
    d = json.loads(raw); u = d.get("usage", {})
    row = {"label": label, "started": int(started), "took_s": int(ended) - int(started),
           "read": u.get("cache_read_input_tokens"), "wrote": u.get("cache_creation_input_tokens"),
           "wrote_5m": (u.get("cache_creation") or {}).get("ephemeral_5m_input_tokens"),
           "wrote_1h": (u.get("cache_creation") or {}).get("ephemeral_1h_input_tokens"),
           "uncached": u.get("input_tokens"), "cost_usd": d.get("total_cost_usd")}
except Exception as e:
    row = {"label": label, "started": int(started), "error": str(e), "raw": raw[:300]}
with open(out, "a") as f: f.write(json.dumps(row) + "\n")
print(json.dumps(row))
EOF
}

case "$which" in
  upgrade)
    run "R1 write 5m"              CLAUDE_CODE_PROMPT_CACHE_TTL=5m
    sleep 60
    run "R2 hit with 1h request"   CLAUDE_CODE_PROMPT_CACHE_TTL=1h
    sleep 420   # 7 min: past the 5m TTL, inside a 1h refresh
    run "R3 after 7m (hit ⇒ request TTL wins)" CLAUDE_CODE_PROMPT_CACHE_TTL=1h
    ;;
  forward)
    run "R1 write 1h"              CLAUDE_CODE_PROMPT_CACHE_TTL=1h
    sleep 3360  # 56 min
    run "R2 hit with 5m request"   CLAUDE_CODE_PROMPT_CACHE_TTL=5m
    sleep 420   # 7 min: past both the original hour and a 5m refresh
    run "R3 at +63m (hit ⇒ 5m request kept the 1h entry)" CLAUDE_CODE_PROMPT_CACHE_TTL=1h
    ;;
  *) echo "usage: $0 <upgrade|forward> <results.jsonl>"; exit 2;;
esac
