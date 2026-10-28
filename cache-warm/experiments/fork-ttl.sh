#!/usr/bin/env bash
# In a steady-state directory (one warm-up run already made), does a fork hit the
# conversation layer, and does CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL set from a
# mod mid-process change the fork's refresh TTL?
#   control: main(5m) → fork (bucket default) → wait 7m → main(5m): write expected if request TTL wins
#   env1h:   main(5m) → fork with env 1h     → wait 7m → main(5m): hit means the env was honored
set -u
which="$1"; out="$2"; probe="$3"; model="${MODEL:-haiku}"
dir="$(mktemp -d)"; cd "$dir"; prompt="Reply with exactly: OK"
run() { local label="$1"; shift; local s=$(date +%s)
  local json; json=$(env "$@" claude -p "$prompt" --output-format json --model "$model" --plugin-dir "$probe" 2>/dev/null); local e=$(date +%s)
  python3 -I - "$label" "$s" "$e" "$out" <<'PY' "$json"
import json,sys
label,s,e,out=sys.argv[1:5]; raw=sys.argv[5]
try:
  d=json.loads(raw); u=d.get("usage",{}); cc=u.get("cache_creation") or {}
  row={"label":label,"started":int(s),"took_s":int(e)-int(s),"read":u.get("cache_read_input_tokens"),"wrote":u.get("cache_creation_input_tokens"),"wrote_5m":cc.get("ephemeral_5m_input_tokens"),"wrote_1h":cc.get("ephemeral_1h_input_tokens"),"uncached":u.get("input_tokens")}
except Exception as ex: row={"label":label,"started":int(s),"error":str(ex),"raw":raw[:200]}
open(out,"a").write(json.dumps(row)+"\n"); print(json.dumps(row))
PY
}
run "W warm-up (first run in dir)" CLAUDE_CODE_PROMPT_CACHE_TTL=5m
sleep 5
case "$which" in
  control) run "M1 main 5m + fork(default bucket)" CLAUDE_CODE_PROMPT_CACHE_TTL=5m CW_PROBE_OUT="$out" ;;
  env1h)   run "M1 main 5m + fork(env 1h)"         CLAUDE_CODE_PROMPT_CACHE_TTL=5m CW_PROBE_OUT="$out" CW_PROBE_FORK_TTL=1h ;;
esac
sleep 420
run "M2 after 7m" CLAUDE_CODE_PROMPT_CACHE_TTL=5m
