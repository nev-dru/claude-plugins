---
name: promote
description: Review this session for durable lessons and corrections (no argument), or promote one lesson (with an argument); drafts hub entries and opens a draft pull request.
disable-model-invocation: true
allowed-tools: Bash(ctx *) Bash(git -C *) Bash(gh pr create *) Bash(bash *scripts/validate.sh) Read Edit Write
---
Two modes. Never `cd`: the hub checkout is `HUB=$(ctx config get hub-dir)`; address it with `--dir`, `git -C "$HUB"`, and absolute paths.

## With an argument: promote one lesson
`/ctx:promote <one-line lesson>` — run steps 5–6 of the review for that lesson only.

## Without an argument: review this session
1. List what this session used: `ctx report --session current`. Note entries marked suspect or wrong, and the zero-result searches (missing entries).
2. Scan the conversation and `MEMORY.md` for durable lessons: a decision made, a gotcha hit twice, a convention someone stated, a runbook step that was missing. Skip one-off facts and anything personal.
3. Propose 0–3 candidates, one line each with the reason it is durable. In interactive mode, stop and let the user pick. With `--auto`, take every candidate and start each factual sentence you could not verify with `CONFIRM:`.
4. For each suspect or wrong entry with evidence from this session, draft a correction in `$HUB/entries/<ID>.md`: set its `status: disputed` and add a `## Dispute` section with the evidence and the date. Never edit an entry without evidence from this session.
5. For each accepted lesson: `ctx new --dir "$HUB" <kind> "<title>"` (kinds: decision, convention, gotcha, how-to, runbook, reference); it prints the file path. Fill `summary` (≤300 characters: what it covers, when to use it, trigger terms), `applies_to` (`component:<name>`, `path:<repo>//<glob>`, or `repo:<repo>`), `sources`, and the body under `## Why` and `## Do`. Check for duplicates with `ctx search "<title>"`; if replacing an entry, add `supersedes: [<old ID>]` and set the old entry's status to `deprecated`.
6. Validate: `bash "$HUB/scripts/validate.sh"`. Then, with `B=promote/<YYYY-MM-DD>-<short>`: `git -C "$HUB" checkout -b "$B"`, `git -C "$HUB" add entries/`, `git -C "$HUB" commit -m "promote: <n> entries, <m> corrections"`, `git -C "$HUB" push -u origin "$B"`, and `gh pr create --repo <owner/hub> --head "$B" --base main --draft --title "promote: <n> entries, <m> corrections" --body "<the candidate list and the evidence for each correction>"` (the owner/hub comes from `git -C "$HUB" remote get-url origin`). Print the PR URL. With `--auto`, add "Drafted automatically at session close; review before merging." to the body.

If nothing durable happened, say so and stop; an empty review is a correct result. Never commit secrets, customer data or anything restricted. Never edit AGENTS.md, and never touch files outside `$HUB/entries/` from this skill.
