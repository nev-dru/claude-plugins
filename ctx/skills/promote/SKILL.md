---
name: promote
description: Review this session for durable lessons and corrections (no argument), or promote one lesson (with an argument); routes each one to the right place (team hub, repo docs, personal layer, CLAUDE.md files) and pushes confirmed hub entries to main.
disable-model-invocation: true
allowed-tools: Bash(ctx *) Bash(ctx-promote *) Bash(date *) Read Edit(~/.config/ctx/**) Write(~/.config/ctx/**) Edit(./docs/**) Write(./docs/**) Edit(./AGENTS.md)
---
Two modes: interactive (the user is here and confirms) and `--auto` (the session-close run; nobody confirms).

All hub writes go through `ctx-promote`, which works in a private worktree and never touches the shared hub checkout:

```
WT=$(ctx-promote start)                     # fresh worktree at origin/main; prints its path
ctx new --dir "$WT" <kind> "<title>"        # draft an entry inside it, then edit the file it prints
ctx-promote commit "$WT" "promote: <n> entries, <m> corrections — <titles>"   # validates, commits entries/ only
ctx-promote publish "$WT" main              # interactive: push to main and install the new index locally
ctx-promote publish "$WT" pr <slug> "<title>" "$WT/.promote-body.md"         # --auto: draft PR on promote/<date>-<slug>
ctx-promote cleanup "$WT"                   # always, including when you stop early
```

## With an argument: promote one lesson
`/ctx:promote <one-line lesson>` — route it (step 4), then write it where step 4 says (steps 6–8 or the personal destinations), then step 9.

## Without an argument: review this session
1. List what this session used: `ctx report --session current`. Note entries marked suspect or wrong, and the zero-result searches (missing entries).
2. Scan the conversation and `MEMORY.md` for durable lessons: a decision made, a gotcha hit twice, a convention someone stated, a runbook step that was missing, and things the user said about themselves or how they work. Keep team and personal items in separate lists.
3. Propose 0–3 team candidates and any personal ones, one line each with the reason it is durable. In interactive mode, stop and let the user pick. With `--auto`, take only team candidates, and start each factual sentence you could not verify with `CONFIRM:`.
4. Route each candidate with the intake guide: read `intake.md` next to this skill (decision table first, layer details when unsure). State the destination and a one-line reason for each.
   - This skill writes to the **hub** (steps 7–8), **repo docs** (step 6), the **personal layer** (`ctx new --local <kind> "<title>"`, fill the file, then `ctx local refresh --background`), and, only after the user confirms the exact line, the **global `~/.claude/CLAUDE.md`** or the repo's **`CLAUDE.local.md`**.
   - For other destinations, say what to do instead: L7 → leave it in the plan/MR; enforcement → propose the deny rule or hook; L1 → propose the exact AGENTS.md line; L4 → propose the skill; L5 → leave it in the source system; L6 → leave it in Claude's project memory; secret → reject.
   - With `--auto`: hub entries only. Never write personal destinations or instruction files, and never put personal content (CLAUDE.md lines, memory, personal notes) in an entry or PR body.
4b. Upkeep (interactive only): read `~/.claude/CLAUDE.md` and the repo's `CLAUDE.local.md` (if present) and apply the checklist in `intake.md` ("Upkeep of the instruction files"). Show each proposal as an exact diff with its reason; apply only the ones the user confirms. With `--auto`, skip upkeep entirely.
5. For each suspect or wrong entry with evidence from this session, draft a correction in `$WT/entries/<ID>.md`: set its `status: disputed` and add a `## Dispute` section with the evidence and the date. Never edit an entry without evidence from this session.
6. Repo docs (interactive only): add the fact to the matching file under the repo's `docs/` (create `docs/<topic>.md` if none fits), and if the file is new, add one line to AGENTS.md: `- <topic>: docs/<topic>.md (read when <trigger>)`. Leave the change uncommitted for the user's next commit. With `--auto`, list these candidates in the PR body under "Belongs in <repo>/docs".
7. Hub: for each accepted lesson, `ctx new --dir "$WT" <kind> "<title>"` (kinds: decision, convention, gotcha, how-to, runbook, reference, project). Fill `summary` (≤300 characters: what it covers, when to use it, trigger terms), `applies_to` (`component:<name>`, `path:<repo>//<glob>`, or `repo:<repo>`), `sources`, and the body under `## Why` and `## Do`. Check for duplicates with `ctx search "<title>"`; if replacing an entry, add `supersedes: [<old ID>]` and set the old entry's status to `deprecated`.
8. `ctx-promote commit "$WT" "<message>"` (it runs the validator; fix errors and retry). Then:
   - **Interactive (the user confirmed the candidates):** `ctx-promote publish "$WT" main`. No pull request: the confirmation was the review; a bad entry is undone with `git revert`. The new index is installed on this machine at once; other machines get the CI release within minutes. Print the commit SHA.
   - **With `--auto`:** write the candidate list and evidence to `$WT/.promote-body.md`, then `ctx-promote publish "$WT" pr <short-slug> "promote: <n> entries, <m> corrections" "$WT/.promote-body.md"`. Add "Drafted automatically at session close; review before merging." to the body. Print the PR URL.
9. Always finish with `ctx-promote cleanup "$WT"`, also when you stop early.

If nothing durable happened, say so, run step 9 if you started a worktree, and stop; an empty review is a correct result. Never commit secrets, customer data or anything restricted.
