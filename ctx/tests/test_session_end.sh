#!/usr/bin/env bash
# Gates for hooks/session-end.sh: no spawn unless opted in, ≥5 user turns, ≥1 ctx lookup, no marker, no recursion.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; SCRIPT="$HERE/../hooks/session-end.sh"
T="$(mktemp -d)"; export CTX_CONFIG="$T/config.json" CTX_SESSIONS_DIR="$T/sessions" CTX_CLAUDE_BIN="$T/claude"
printf '#!/usr/bin/env bash\necho "$@" > "%s/spawned"; echo "NOPERSONAL=$CTX_NO_PERSONAL" >> "%s/spawned"\n' "$T" "$T" > "$T/claude"; chmod +x "$T/claude"
# Real transcripts carry tool results as "user" rows and the plugin's own pointer lines mention `ctx get`;
# neither may count as a turn or a lookup.
mk_transcript() { local turns=$1 lookups=$2; : > "$T/t.jsonl"
  for ((i=0;i<turns;i++)); do echo '{"type":"user","message":{"content":"hi"}}' >> "$T/t.jsonl"; done
  for ((i=0;i<6;i++)); do echo '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}' >> "$T/t.jsonl"; done
  echo '{"type":"user","message":{"content":"Team knowledge: [01J9ZK3Q7R8M2V5X1B4N6D8F0A] x → ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0A"}}' >> "$T/t.jsonl"
  for ((i=0;i<lookups;i++)); do echo '{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"command":"ctx search x"}}]}}' >> "$T/t.jsonl"; done; }
run() { printf '{"session_id":"s1","transcript_path":"%s","cwd":"/work","hook_event_name":"SessionEnd","reason":"other"}' "$T/t.jsonl" | bash "$SCRIPT"; }
fail() { echo "FAIL: $1"; exit 1; }
mk_transcript 6 1
echo '{"auto_promote": false}' > "$CTX_CONFIG"; run; [ ! -e "$T/spawned" ] || fail "spawned while auto_promote off"
echo '{"auto_promote": true, "hub_dir": "/tmp/hub", "review_model": "haiku"}' > "$CTX_CONFIG"
mk_transcript 3 1; run; [ ! -e "$T/spawned" ] || fail "spawned with 3 user turns"
mk_transcript 6 0; run; [ ! -e "$T/spawned" ] || fail "spawned with no lookups"
mk_transcript 6 1; CTX_REVIEW=1 run; [ ! -e "$T/spawned" ] || fail "spawned inside a review (recursion)"
start=$(date +%s%N); run; end=$(date +%s%N); sleep 0.3
[ -e "$T/spawned" ] || fail "did not spawn when all gates pass"
grep -q -- "--resume s1" "$T/spawned" || fail "resume id missing: $(cat "$T/spawned")"
grep -q -- "/ctx:promote --auto" "$T/spawned" || fail "review prompt missing"
grep -q -- "--add-dir" "$T/spawned" || fail "hub dir not added for the headless run"
grep -q -- "--disallowedTools" "$T/spawned" || fail "dangerous tools not disallowed"
grep -qF -- "Bash(ctx-promote publish * main*)" "$T/spawned" || fail "publish to main not denied"
grep -q -- "--model haiku" "$T/spawned" || fail "review model from config not passed"
grep -q "NOPERSONAL=1" "$T/spawned" || fail "the unattended run can see the personal layer"
grep -q -- "Bash(ctx-promote" "$T/spawned" || fail "hub writes not routed through ctx-promote"
ALLOWED="$(sed -n 's/.*--allowedTools \(.*\) --disallowedTools.*/\1/p' "$T/spawned")"
[[ "$ALLOWED" != *"Bash(git"* && "$ALLOWED" != *"Bash(gh"* ]] || fail "raw git or gh allowed: $ALLOWED"
grep -q -- "--disallowedTools.*Bash(git \*).*Bash(gh \*)" "$T/spawned" || fail "raw git/gh not denied"
[ $(( (end - start) / 1000000 )) -lt 1000 ] || fail "took longer than 1 s"
rm -f "$T/spawned"; run; [ ! -e "$T/spawned" ] || fail "spawned twice for one session (marker)"
# no review_model configured: the run still starts (macOS bash 3.2 + set -u + empty array)
echo '{"auto_promote": true}' > "$CTX_CONFIG"
printf '{"session_id":"s2","transcript_path":"%s"}' "$T/t.jsonl" | bash "$SCRIPT"; sleep 0.3
[ -e "$T/spawned" ] || fail "no spawn when review_model is unset"
! grep -q -- "--model" "$T/spawned" || fail "--model passed without a configured model"
rm -f "$T/spawned"
printf '{"session_id":"../evil","transcript_path":"%s","cwd":"/work","hook_event_name":"SessionEnd","reason":"other"}' "$T/t.jsonl" | bash "$SCRIPT"
[ ! -e "$T/spawned" ] || fail "spawned with an invalid session id"
echo "OK session-end gates"
