---
name: promote
description: Review this session for durable lessons and corrections (no argument), or promote one lesson (with an argument); drafts hub entries and opens a draft pull request.
disable-model-invocation: true
allowed-tools: Bash(ctx *) Bash(git *) Bash(gh *) Bash(scripts/validate.sh) Read Write Edit
---
Two modes. The hub is at `~/dev/context-hub`; work from that directory for `ctx new`, validation, git and gh.

## With an argument: promote one lesson
`/ctx:promote <one-line lesson>` — run steps 5–6 of the review for that lesson only.

## Without an argument: review this session
1. List what this session used: `ctx report --session current`. Note entries marked suspect or wrong, and the zero-result searches (missing entries).
2. Scan the conversation and `MEMORY.md` for durable lessons: a decision made, a gotcha hit twice, a convention someone stated, a runbook step that was missing. Skip one-off facts and anything personal.
3. Propose 0–3 candidates, one line each with the reason it is durable. In interactive mode, stop and let the user pick. With `--auto`, take every candidate and start each factual sentence you could not verify with `CONFIRM:`.
4. For each suspect or wrong entry with evidence from this session, draft a correction: set its `status: disputed` and add a `## Dispute` section with the evidence and the date. Never edit an entry without evidence from this session.
5. For each accepted lesson: `ctx new <kind> "<title>"` (kinds: decision, convention, gotcha, how-to, runbook, reference). Fill `summary` (≤300 characters: what it covers, when to use it, trigger terms), `applies_to` (`component:<name>`, `path:rufalow//<glob>`, or `repo:rufalow`), `sources`, and the body under `## Why` and `## Do`. Check for duplicates with `ctx search "<title>"`; if replacing an entry, add `supersedes: [<old ID>]` and set the old entry's status to `deprecated`.
6. Validate with `scripts/validate.sh`. Create a branch `promote/<YYYY-MM-DD>-<short>`, commit, push, and open a draft PR: `gh pr create --draft --title "promote: <n> entries, <m> corrections" --body "<the candidate list and the evidence for each correction>"`. Print the PR URL. With `--auto`, add "Drafted automatically at session close; review before merging." to the body.

If nothing durable happened, say so and stop; an empty review is a correct result. Never commit secrets, customer data or anything restricted. Never edit AGENTS.md from this skill.
