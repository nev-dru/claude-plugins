#!/usr/bin/env bash
# One long-lived headless session (stdin held open). Turn 1 at T0 writes a 1h
# entry; the probe mod forks at +56m; turn 2 at +63m: a hit means the fork's
# refresh lasted an hour (the entry's own lifetime ended at +60m).
set -u
out="$1"; probe="$2"; dir="$(mktemp -d)"; cd "$dir"
P='Run the shell command `echo probe-hello` with the Bash tool, then reply with exactly: OK'
msg() { python3 -I -c 'import json,sys; print(json.dumps({"type":"user","message":{"role":"user","content":[{"type":"text","text":sys.argv[1]}]}}))' "$1"; }
# warm-up run so the directory is in steady state
claude -p "$P" --output-format json --model haiku --allowedTools "Bash(echo:*)" >/dev/null 2>&1
sleep 4
( msg "$P"; sleep 3780; msg "$P (second turn)"; sleep 20 ) | \
  CW_PROBE_OUT="$out" CW_PROBE_DELAY_MS=3360000 claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --allowedTools "Bash(echo:*)" --plugin-dir "$probe" 2>"$out.err" | \
  python3 -I -c '
import sys,json,time
for line in sys.stdin:
    try: d=json.loads(line)
    except Exception: continue
    if d.get("type")=="result":
        u=d.get("usage",{}); cc=u.get("cache_creation") or {}
        row={"label":"turn result","at":int(time.time()),"read":u.get("cache_read_input_tokens"),"wrote":u.get("cache_creation_input_tokens"),"wrote_5m":cc.get("ephemeral_5m_input_tokens"),"wrote_1h":cc.get("ephemeral_1h_input_tokens"),"num_turns":d.get("num_turns")}
        open(sys.argv[1],"a").write(json.dumps(row)+"\n"); print(json.dumps(row), flush=True)
' "$out"
