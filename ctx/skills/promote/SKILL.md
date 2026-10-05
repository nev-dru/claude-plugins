---
name: promote
description: Draft a new team knowledge entry from a lesson in this session or a personal note, and open a draft pull request in the hub.
disable-model-invocation: true
allowed-tools: Bash(ctx *) Bash(git *) Bash(gh *) Read Write
---
Promote one durable lesson into the hub at `~/dev/context-hub`. Steps:

1. Decide the kind: decision, convention, gotcha, how-to, runbook or reference. If the lesson is only useful to this one person, stop and say it belongs in personal memory.
2. From the hub directory run `ctx new <kind> "<title>"`. It prints the new file path.
3. Fill the file: `summary` (≤300 characters: what it covers, when to use it, trigger terms), `applies_to` (`component:<name>`, `path:rufalow//<glob>`, or `repo:rufalow`), `sources` (file paths, ADR rows, MR links). Write the body under `## Why` and `## Do`. Put `CONFIRM:` at the start of every factual sentence you could not verify in this session; the human removes them.
4. Check for duplicates: `ctx search "<title>"`. If a matching active entry exists, say so and stop; if it is being replaced, add `supersedes: [<old ID>]` and set the old entry's status to `deprecated`.
5. Validate: `scripts/validate.sh`.
6. Create a branch `promote/<ID>`, commit the entry, push, and open a draft PR: `gh pr create --draft --title "entry: <title>" --body "Drafted by the promote skill; CONFIRM markers need review."`. Print the PR URL.

Never commit secrets, customer data or anything restricted. Never edit AGENTS.md from this skill.
