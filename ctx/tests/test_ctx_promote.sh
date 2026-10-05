#!/usr/bin/env bash
# bin/ctx-promote: every hub write goes through it. It must keep work in a private worktree, refuse paths
# outside ~/.config/ctx/promote, refuse odd branch names, and never push to main inside an unattended run.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; P="$HERE/../bin/ctx-promote"
T="$(mktemp -d)"; export HOME="$T/home"; mkdir -p "$HOME"
fail() { echo "FAIL: $1"; exit 1; }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
# a hub with an origin
git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/hub" 2>/dev/null
mkdir -p "$T/hub/entries" "$T/hub/scripts"
printf '#!/usr/bin/env bash\necho OK\n' > "$T/hub/scripts/validate.sh"; chmod +x "$T/hub/scripts/validate.sh"
echo seed > "$T/hub/entries/seed.md"; git -C "$T/hub" add -A; git -C "$T/hub" commit -q -m seed; git -C "$T/hub" push -q origin HEAD:main 2>/dev/null
git -C "$T/hub" branch -q -M main
export CTX_HUB_DIR="$T/hub"
# stand-ins for gh and make
mkdir -p "$T/bin"; printf '#!/usr/bin/env bash\necho "gh $*" >> "%s/gh.log"; echo https://example/pr/1\n' "$T" > "$T/bin/gh"; chmod +x "$T/bin/gh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$T/bin/make"; chmod +x "$T/bin/make"
export PATH="$T/bin:$PATH" CTX_PROMOTE_NO_SYNC=1

WT="$("$P" start)"
case "$WT" in "$HOME/.config/ctx/promote/"*) ;; *) fail "worktree not under ~/.config/ctx/promote: $WT";; esac
[ "$(git -C "$T/hub" rev-parse --abbrev-ref HEAD)" = main ] || fail "shared checkout switched branch"
echo "new entry" > "$WT/entries/new.md"
echo "stray" > "$WT/README.md"
"$P" commit "$WT" "promote: 1 entry" >/dev/null
STAT="$(git -C "$WT" show --stat HEAD)"
[[ "$STAT" == *"entries/new.md"* ]] || fail "entry not committed"
[[ "$STAT" != *"README.md"* ]] || fail "files outside entries/ committed"

# unattended runs may not push to main, whatever the arguments look like
if CTX_REVIEW=1 "$P" publish "$WT" main >/dev/null 2>&1; then fail "pushed to main inside an unattended run"; fi
# odd branch names and paths are refused
echo "body" > "$WT/.promote-body.md"
if "$P" publish "$WT" pr "x;rm -rf /" "t" "$WT/.promote-body.md" >/dev/null 2>&1; then fail "bad slug accepted"; fi
if "$P" commit "$HOME/.config/ctx/promote/../../../hub" "m" >/dev/null 2>&1; then fail "traversal out of the promote dir accepted"; fi
if "$P" commit "$T/hub" "m" >/dev/null 2>&1; then fail "the shared checkout accepted as a worktree"; fi

# the unattended run opens a draft PR on a promote/ branch
CTX_REVIEW=1 "$P" publish "$WT" pr "add-entry" "promote: 1 entry" "$WT/.promote-body.md" >/dev/null
[[ "$(git -C "$T/origin.git" branch --list 'promote/*')" == *"add-entry"* ]] || fail "promote branch not pushed"
grep -q -- "--draft" "$T/gh.log" || fail "PR not a draft"

# an interactive publish goes straight to main
"$P" publish "$WT" main >"$T/pub.out" 2>&1 || { cat "$T/pub.out"; fail "publish main failed"; }
[[ "$(git -C "$T/origin.git" log --oneline main)" == *"promote: 1 entry"* ]] || fail "not pushed to main"

"$P" cleanup "$WT"
[ ! -e "$WT" ] || fail "worktree not removed"
echo "OK ctx-promote"
