#!/usr/bin/env bash
# Gates for hooks/session-end.sh: no spawn unless opted in, ≥5 user turns, ≥1 ctx lookup, no marker, no recursion.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; SCRIPT="$HERE/../hooks/session-end.sh"
T="$(mktemp -d)"; export CTX_CONFIG="$T/config.json" CTX_SESSIONS_DIR="$T/sessions" CTX_CLAUDE_BIN="$T/claude"
printf '#!/usr/bin/env bash\necho "$@" > "%s/spawned"\n' "$T" > "$T/claude"; chmod +x "$T/claude"
mk_transcript() { local turns=$1 lookups=$2; : > "$T/t.jsonl"
  for ((i=0;i<turns;i++)); do echo '{"type":"user","message":{"content":"hi"}}' >> "$T/t.jsonl"; done
  for ((i=0;i<lookups;i++)); do echo '{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"command":"ctx search x"}}]}}' >> "$T/t.jsonl"; done; }
run() { printf '{"session_id":"s1","transcript_path":"%s","cwd":"/work","hook_event_name":"SessionEnd","reason":"other"}' "$T/t.jsonl" | bash "$SCRIPT"; }
fail() { echo "FAIL: $1"; exit 1; }
mk_transcript 6 1
echo '{"auto_promote": false}' > "$CTX_CONFIG"; run; [ ! -e "$T/spawned" ] || fail "spawned while auto_promote off"
echo '{"auto_promote": true}' > "$CTX_CONFIG"
mk_transcript 3 1; run; [ ! -e "$T/spawned" ] || fail "spawned with 3 user turns"
mk_transcript 6 0; run; [ ! -e "$T/spawned" ] || fail "spawned with no lookups"
mk_transcript 6 1; CTX_REVIEW=1 run; [ ! -e "$T/spawned" ] || fail "spawned inside a review (recursion)"
start=$(date +%s%N); run; end=$(date +%s%N); sleep 0.3
[ -e "$T/spawned" ] || fail "did not spawn when all gates pass"
grep -q -- "--resume s1" "$T/spawned" || fail "resume id missing: $(cat "$T/spawned")"
grep -q -- "/ctx:promote --auto" "$T/spawned" || fail "review prompt missing"
[ $(( (end - start) / 1000000 )) -lt 1000 ] || fail "took longer than 1 s"
rm -f "$T/spawned"; run; [ ! -e "$T/spawned" ] || fail "spawned twice for one session (marker)"
echo "OK session-end gates"
