#!/usr/bin/env bash
# bin/ctx-promote: every hub commit and push goes through it. Managed clones work in a private worktree (rebased
# before a push, pending refs when a push fails); the user's own checkout is never pulled, rebased or stashed and
# must be on the hub's branch; only the files ctx place apply wrote are staged; ctx scan runs before every commit
# and push; unattended runs never push to the branch.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; P="$HERE/../bin/ctx-promote"
T="$(mktemp -d)"; T="$(cd "$T" && pwd -P)"; export HOME="$T/home"; mkdir -p "$HOME"
fail() { echo "FAIL: $1"; exit 1; }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
origin() {  # origin <name>: a bare repo with one commit on main, and a clone of it at $T/<name>
  git init -q --bare -b main "$T/$1.git"
  git clone -q "$T/$1.git" "$T/$1" 2>/dev/null
  mkdir -p "$T/$1/entries" "$T/$1/scripts"; echo seed > "$T/$1/entries/seed.md"
  git -C "$T/$1" add -A; git -C "$T/$1" commit -q -m seed; git -C "$T/$1" branch -q -M main; git -C "$T/$1" push -q origin main 2>/dev/null
}
origin team; origin vault
printf '#!/usr/bin/env bash\necho OK\n' > "$T/team/scripts/validate.sh"; chmod +x "$T/team/scripts/validate.sh"

# stand-ins for ctx and gh
export CTX_STUB="$T/stub"; mkdir -p "$T/bin" "$CTX_STUB/hubs"
cat > "$T/bin/ctx" <<'EOF'
#!/usr/bin/env bash
S="$CTX_STUB"
case "$1 $2" in
  "hub show") [ -f "$S/hubs/$3/$5" ] || exit 1; cat "$S/hubs/$3/$5" ;;
  "place session") mkdir -p "$S/sess"; echo "$S/sess" ;;
  "place cleanup") rm -rf "$S/sess" ;;
  "sync --hub") ;;
  *) if [ "$1" = scan ]; then echo "$*" >> "$S/scan.log"; if [ -e "$S/scan-fail" ]; then echo '{"hits":[{"check":"secret"}]}'; exit 1; fi; echo '{"hits":[]}'; else exit 3; fi ;;
esac
EOF
chmod +x "$T/bin/ctx"
printf '#!/usr/bin/env bash\necho "gh $*" >> "%s/gh.log"; echo https://example/pr/1\n' "$T" > "$T/bin/gh"; chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" CTX_PROMOTE_NO_SYNC=1
mkhub() { local d="$CTX_STUB/hubs/$1"; mkdir -p "$d"; echo "$1" > "$d/name"; echo "$2" > "$d/root"; echo "$3" > "$d/managed"; echo main > "$d/branch"; echo editable > "$d/mode"; echo "${4:-false}" > "$d/main"; }
mkhub team "$T/team" true true
mkhub vault "$T/vault" false
origin kb; mkhub kb "$T/kb" true
SESS="$CTX_STUB/sess"; mkdir -p "$SESS"

# --- a managed clone: private worktree, manifest-only staging, trailers, scans
WT="$("$P" start team)"
case "$WT" in "$HOME/.config/ctx/promote/team-"*) ;; *) fail "worktree not under ~/.config/ctx/promote: $WT";; esac
[ "$(git -C "$T/team" rev-parse --abbrev-ref HEAD)" = main ] || fail "the managed clone switched branch"
echo "new entry" > "$WT/entries/new.md"; echo "stray" > "$WT/README.md"
printf 'entries/new.md\t1\t0\n' > "$SESS/team.manifest"; printf 'Scan-Allowed: fake:0123456789ab — fixture\n' > "$SESS/team.trailers"
"$P" commit team "$WT" "promote: 1 entry" >/dev/null
STAT="$(git -C "$WT" show --stat HEAD)"; MSG="$(git -C "$WT" log -1 --format=%B)"
[[ "$STAT" == *"entries/new.md"* ]] || fail "entry not committed"
[[ "$STAT" != *"README.md"* ]] || fail "a file apply did not write was committed"
[[ "$MSG" == *"Scan-Allowed: fake:0123456789ab — fixture"* ]] || fail "trailers missing: $MSG"
grep -q -- "--text" "$CTX_STUB/scan.log" && grep -q "entries/new.md" "$CTX_STUB/scan.log" || fail "commit did not scan the message and the files"
[ ! -s "$SESS/team.manifest" ] || fail "the manifest is cleared once committed"

# a scan hit refuses the commit
echo "second" > "$WT/entries/two.md"; printf 'entries/two.md\t2\t0\n' > "$SESS/team.manifest"; touch "$CTX_STUB/scan-fail"
BEFORE="$(git -C "$WT" rev-parse HEAD)"
if "$P" commit team "$WT" "promote: two" >/dev/null 2>&1; then fail "committed despite a scan hit"; fi
[ "$(git -C "$WT" rev-parse HEAD)" = "$BEFORE" ] || fail "HEAD moved on a refused commit"
rm "$CTX_STUB/scan-fail"; git -C "$WT" clean -qf entries/two.md; : > "$SESS/team.manifest"

# argument shapes that are refused
if CTX_REVIEW=1 "$P" publish team "$WT" main >/dev/null 2>&1; then fail "pushed to main inside an unattended run"; fi
echo "body" > "$WT/.promote-body.md"
if "$P" publish team "$WT" pr "x;rm -rf /" "t" "$WT/.promote-body.md" >/dev/null 2>&1; then fail "bad slug accepted"; fi
if "$P" commit team "$HOME/.config/ctx/promote/../../../team" "m" >/dev/null 2>&1; then fail "traversal out of the promote dir accepted"; fi
if "$P" commit team "$T/team" "m" >/dev/null 2>&1; then fail "the managed clone accepted as a checkout"; fi
if "$P" start "Bad Name" >/dev/null 2>&1; then fail "bad hub name accepted"; fi

# the unattended run opens a draft PR and scans the title and body
CTX_REVIEW=1 "$P" publish team "$WT" pr "add-entry" "promote: 1 entry" "$WT/.promote-body.md" >/dev/null
[[ "$(git -C "$T/team.git" branch --list 'promote/*')" == *"add-entry"* ]] || fail "promote branch not pushed"
grep -q -- "--draft" "$T/gh.log" || fail "PR not a draft"
grep -q "pr-title.txt" "$CTX_STUB/scan.log" && grep -q ".promote-body.md" "$CTX_STUB/scan.log" || fail "PR title and body not scanned"

# unattended runs touch the main team hub only; a worktree belongs to its own hub; read-only managed hubs are refused
if CTX_REVIEW=1 "$P" start vault >/dev/null 2>&1; then fail "an unattended run started a hub other than the main team hub"; fi
if CTX_REVIEW=1 "$P" start kb >/dev/null 2>&1; then fail "an unattended run started a non-main managed hub"; fi
KBWT="$("$P" start kb)"
if "$P" commit team "$KBWT" "m" >/dev/null 2>&1; then fail "another hub's worktree accepted as team's checkout"; fi
"$P" cleanup kb "$KBWT"; mkdir -p "$SESS"
echo read-only > "$CTX_STUB/hubs/kb/mode"
if "$P" start kb >/dev/null 2>&1; then fail "a read-only managed hub was started"; fi
echo editable > "$CTX_STUB/hubs/kb/mode"

# an interactive publish goes to main after a range scan
"$P" publish team "$WT" main >"$T/pub.out" 2>&1 || { cat "$T/pub.out"; fail "publish main failed"; }
[[ "$(git -C "$T/team.git" log --oneline main)" == *"promote: 1 entry"* ]] || fail "not pushed to main"
grep -q -- "--range" "$CTX_STUB/scan.log" || fail "publish did not scan the commit range"
"$P" cleanup team "$WT"; [ ! -e "$WT" ] || fail "worktree not removed"; [ ! -e "$SESS" ] || fail "session folder not cleared"

# a rejected push keeps the commit as a pending ref; push retries it
WT="$("$P" start team)"; mkdir -p "$SESS"
echo "three" > "$WT/entries/three.md"; printf 'entries/three.md\t3\t0\n' > "$SESS/team.manifest"
"$P" commit team "$WT" "promote: three" >/dev/null
printf '#!/bin/sh\nexit 1\n' > "$T/team.git/hooks/pre-receive"; chmod +x "$T/team.git/hooks/pre-receive"
if "$P" publish team "$WT" main >/dev/null 2>&1; then fail "a rejected push reported success"; fi
[ -n "$(git -C "$T/team" for-each-ref 'refs/ctx/pending/team/')" ] || fail "no pending ref after a rejected push"
"$P" cleanup team "$WT"
rm "$T/team.git/hooks/pre-receive"
"$P" push team >/dev/null || fail "push did not retry the pending commit"
[[ "$(git -C "$T/team.git" log --oneline main)" == *"promote: three"* ]] || fail "pending commit not on main"
[ -z "$(git -C "$T/team" for-each-ref 'refs/ctx/pending/team/')" ] || fail "pending ref not removed after the push"

# cleanup keeps an unpushed commit (before-sharing, the user said not yet)
WT="$("$P" start team)"; mkdir -p "$SESS"
echo "four" > "$WT/entries/four.md"; printf 'entries/four.md\t4\t0\n' > "$SESS/team.manifest"
"$P" commit team "$WT" "promote: four" >/dev/null
"$P" cleanup team "$WT" 2>/dev/null
[ -n "$(git -C "$T/team" for-each-ref 'refs/ctx/pending/team/')" ] || fail "cleanup lost an unpushed commit"

# a draft PR is the review: cleanup after it keeps no pending ref, so a later push never sends it to main
git -C "$T/team" for-each-ref --format='%(refname)' 'refs/ctx/pending/team/' | while read -r r; do git -C "$T/team" update-ref -d "$r"; done
WT="$(CTX_REVIEW=1 "$P" start team)"; mkdir -p "$SESS"
echo "five" > "$WT/entries/five.md"; printf 'entries/five.md\t5\t0\n' > "$SESS/team.manifest"
CTX_REVIEW=1 "$P" commit team "$WT" "promote: five" >/dev/null
echo body > "$WT/.promote-body.md"
CTX_REVIEW=1 "$P" publish team "$WT" pr "five" "promote: five" "$WT/.promote-body.md" >/dev/null
CTX_REVIEW=1 "$P" cleanup team "$WT" 2>/dev/null
[ -z "$(git -C "$T/team" for-each-ref 'refs/ctx/pending/team/')" ] || fail "a commit already in a draft PR was kept as pending"

# --- the user's own checkout: written in place, never pulled or rebased, must be on the hub's branch
VAULT="$(cd "$T/vault" && pwd -P)"
[ "$("$P" start vault)" = "$VAULT" ] || fail "start vault must print the vault's own folder"
git -C "$T/vault" switch -q -c feature
if "$P" start vault >/dev/null 2>&1; then fail "a checkout on another branch accepted"; fi
git -C "$T/vault" switch -q main
mkdir -p "$SESS" "$T/vault/notes"; echo "note" > "$T/vault/notes/a.md"; echo "mine" > "$T/vault/mine.md"
printf 'notes/a.md\t1\t0\n' > "$SESS/vault.manifest"
"$P" commit vault "$T/vault" "notes: a" >/dev/null
[[ "$(git -C "$T/vault" show --stat HEAD)" != *"mine.md"* ]] || fail "the user's own file was committed"
[ -f "$T/vault/mine.md" ] && [ -n "$(git -C "$T/vault" status --porcelain -- mine.md)" ] || fail "the user's own file was touched"
git clone -q "$T/vault.git" "$T/other" 2>/dev/null; echo x > "$T/other/x.md"; git -C "$T/other" add x.md; git -C "$T/other" commit -q -m other; git -C "$T/other" push -q origin main 2>/dev/null
if "$P" publish vault "$T/vault" main >"$T/v.out" 2>&1; then fail "pushed over a remote that moved"; fi
grep -q "pull there yourself" "$T/v.out" || fail "no instruction to pull: $(cat "$T/v.out")"
[ "$(git -C "$T/vault" log --oneline -1 --format=%s)" = "notes: a" ] || fail "the user's checkout was rebased or merged"
git -C "$T/vault" pull -q --no-rebase origin main 2>/dev/null
"$P" push vault >/dev/null || fail "push vault after the user pulled"
[[ "$(git -C "$T/vault.git" log --oneline main)" == *"notes: a"* ]] || fail "vault commit not pushed"
if "$P" commit vault "$T/team" "m" >/dev/null 2>&1; then fail "another folder accepted as the vault's checkout"; fi
"$P" cleanup vault "$T/vault"; [ -d "$T/vault" ] || fail "cleanup removed the user's checkout"
echo "OK ctx-promote"
