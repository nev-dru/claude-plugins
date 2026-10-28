#!/usr/bin/env bash
# Two-step turn (tool call) so the fork hits the whole prefix. Does the fork's
# hit refresh the main's 5m entries for 5m (control) or 1h (static1h)?
set -u
which="$1"; out="$2"; probe="$3"; model="${MODEL:-haiku}"
dir="$(mktemp -d)"; cd "$dir"
prompt='Run the shell command `echo probe-hello` with the Bash tool, then reply with exactly: OK'
run() { local label="$1"; shift; local s=$(date +%s)
  local json; json=$(env "$@" claude -p "$prompt" --output-format json --model "$model" --allowedTools "Bash(echo:*)" --plugin-dir "$probe" 2>/dev/null); local e=$(date +%s)
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
run "W warm-up" CLAUDE_CODE_PROMPT_CACHE_TTL=5m
sleep 5
case "$which" in
  control)  run "M1 main 5m + fork(default)"          CLAUDE_CODE_PROMPT_CACHE_TTL=5m CW_PROBE_OUT="$out" ;;
  static1h) run "M1 main 5m + fork(SUBAGENT 1h static)" CLAUDE_CODE_PROMPT_CACHE_TTL=5m CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h CW_PROBE_OUT="$out" ;;
esac
sleep 420
run "M2 after 7m (read≈90k ⇒ fork refreshed for 1h)" CLAUDE_CODE_PROMPT_CACHE_TTL=5m
