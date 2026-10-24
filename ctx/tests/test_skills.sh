#!/usr/bin/env bash
# The skills carry the hub routing flow: the promote skill files hub rows through ctx place and ctx-promote with the
# reply grammar, never skips a row silently and asks before pushing; the search skill narrows with --hub; intake has
# row 5a; the hub skill names the before-sharing default. (The plugin test kit cannot read files, so this is bash.)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; S="$HERE/../skills"
fail() { echo "FAIL: $1"; exit 1; }
for s in 'ctx place signals' 'ctx place apply' 'ctx-promote start <hub>' 'ctx-promote commit <hub>' '`go`' '`yes N`' \
  'Never skip a row silently' '`push <hub> (<n> notes)?`' '`allow N <reason>`' '`redact N`' '`show N`' '`N → hub + hub`'; do
  grep -qF -- "$s" "$S/promote/SKILL.md" || fail "promote skill lacks: $s"
done
if grep -q 'disable-model-invocation' "$S/promote/SKILL.md"; then fail "the model must be able to open the promote skill"; fi
grep -qF 'clearly about one hub' "$S/search/SKILL.md" || fail "search skill lacks the --hub rule"
grep -qF '| 5a |' "$S/promote/intake.md" || fail "intake lacks row 5a"
grep -qF 'before-sharing' "$S/hub/SKILL.md" || fail "hub skill lacks the before-sharing default"
echo "OK skills"
