---
name: promote
description: Review this session for durable lessons and corrections (no argument), or promote one lesson (with an argument); routes each one to the repo's docs or the team hub; confirmed hub entries are committed and pushed to main.
disable-model-invocation: true
allowed-tools: Bash(ctx *) Bash(git -C *) Bash(gh pr create *) Bash(bash *scripts/validate.sh) Bash(make -C *) Bash(date *) Read Edit Write
---
Two modes. Never `cd`. The hub checkout is `HUB=$(ctx config get hub-dir)`, and other sessions may be using it, so **never switch its branch or write in it**. All hub writes happen in a private worktree made fresh from `origin/main`:

```
WT="$HOME/.config/ctx/promote/$(date +%Y%m%d-%H%M%S)"
git -C "$HUB" fetch -q origin && git -C "$HUB" worktree add -q --detach "$WT" origin/main
```

Address it with `--dir "$WT"`, `git -C "$WT"`, and absolute paths under `$WT`.

## With an argument: promote one lesson
`/ctx:promote <one-line lesson>` — route it (step 4), then run step 6 or 7–8 for that lesson only.

## Without an argument: review this session
1. List what this session used: `ctx report --session current`. Note entries marked suspect or wrong, and the zero-result searches (missing entries).
2. Scan the conversation and `MEMORY.md` for durable lessons: a decision made, a gotcha hit twice, a convention someone stated, a runbook step that was missing. Skip one-off facts and anything personal.
3. Propose 0–3 candidates, one line each with the reason it is durable. In interactive mode, stop and let the user pick. With `--auto`, take every candidate and start each factual sentence you could not verify with `CONFIRM:`.
4. Route each candidate with the intake guide: read `intake.md` next to this skill (decision table first, layer details when unsure). State the destination layer and the one-line reason for each candidate. Destinations this skill writes: **repo docs** (step 6), **hub** (steps 7–8), **personal layer** (`ctx new --local <kind> "<title>"`, fill it, then `ctx local refresh --background`; no confirmation needed beyond the candidate pick), and — only after the user confirms the exact line — **global `~/.claude/CLAUDE.md`** or the repo's **`CLAUDE.local.md`**. For the others, say what to do instead: L7 → leave in the plan/MR; enforcement → propose the deny rule or hook; L1 → propose the exact AGENTS.md line for a human to add; L4 → propose the skill; L5 → leave it in the source system (declare the source if it is new); L6 → leave it in memory; secret → reject.
4b. Upkeep: read `~/.claude/CLAUDE.md` and the repo's `CLAUDE.local.md` (if present) and apply the checklist in `intake.md` ("Upkeep of the instruction files"): duplicates, contradictions, stale lines, misplaced lines, size. Show each proposal as an exact diff with its reason; apply only the ones the user confirms. With `--auto`, list them in the PR body and change nothing.
5. For each suspect or wrong entry with evidence from this session, draft a correction in `$WT/entries/<ID>.md`: set its `status: disputed` and add a `## Dispute` section with the evidence and the date. Never edit an entry without evidence from this session.
6. Repo docs (interactive mode only): add the fact to the matching file under the repo's `docs/` (create `docs/<topic>.md` if none fits), and if the file is new, add one line to AGENTS.md: `- <topic>: docs/<topic>.md (read when <trigger>)`. Leave the change uncommitted in the working tree for the user's next commit. With `--auto`, do not touch repo files: list these candidates in the PR body under "Belongs in <repo>/docs".
7. Hub: for each accepted lesson: `ctx new --dir "$WT" <kind> "<title>"` (kinds: decision, convention, gotcha, how-to, runbook, reference); it prints the file path. Fill `summary` (≤300 characters: what it covers, when to use it, trigger terms), `applies_to` (`component:<name>`, `path:<repo>//<glob>`, or `repo:<repo>`), `sources`, and the body under `## Why` and `## Do`. Check for duplicates with `ctx search "<title>"`; if replacing an entry, add `supersedes: [<old ID>]` and set the old entry's status to `deprecated`.
8. Validate: `bash "$WT/scripts/validate.sh"`; fix any error before going on. Commit in the worktree: `git -C "$WT" add entries/ && git -C "$WT" commit -m "promote: <n> entries, <m> corrections — <titles>"`.
   - **Interactive (the user confirmed the candidates):** push straight to main: `git -C "$WT" push origin HEAD:main`. If it is rejected because main moved, `git -C "$WT" pull --rebase origin main` and push again. No pull request: the confirmation was the review; a bad entry is undone with `git revert`. Then make the entries live on this machine at once: `make -C "$WT" index && ctx sync --from "$WT/build" --no-views` (every open session sees them on its next prompt; other machines get the CI release within minutes). Print the commit SHA.
   - **With `--auto` (nobody confirmed):** push a branch and open a draft PR: `B=promote/<YYYY-MM-DD>-<short>`, `git -C "$WT" push origin HEAD:refs/heads/$B`, `gh pr create --repo <owner/hub> --head "$B" --base main --draft --title "promote: <n> entries, <m> corrections" --body "<candidates and evidence>. Drafted automatically at session close; review before merging."` (owner/hub from `git -C "$HUB" remote get-url origin`). Print the PR URL.
9. Clean up: `git -C "$HUB" worktree remove "$WT"` (if it refuses because of build output, leave it; it lives under ~/.config/ctx/promote).

If nothing durable happened, say so and stop; an empty review is a correct result. Never commit secrets, customer data or anything restricted. Outside `$WT/entries/`, edit only the current repo's `docs/` files and one AGENTS.md link line per new file, and only in interactive mode.
