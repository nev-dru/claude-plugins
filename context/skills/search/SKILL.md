---
name: search
description: Search the team's reviewed knowledge entries with the ctx tool. Use when a task touches a decision, convention, gotcha or runbook that may already be written down, before re-deriving it from code; also when the routing index or a pointer names an entry ID.
allowed-tools: Bash(ctx *)
---
Run searches with the `ctx` command (on PATH). It returns cards: `[ID] title (kind · scope · date)` and a summary.

1. `ctx search "<the question in plain words>"` (limit 10). Read the cards.
2. If nothing fits, retry once with one identifier from the task (an error string, service name, env var, file path): `ctx search "<identifier>"`.
3. Open the best card: `ctx get <ID>` (card, summary, section names). Read a section only if the summary cites the answer: `ctx get <ID> --section <name>`. Use `--full` only when the whole entry is needed.
4. A card marked superseded names its replacement; use that ID. A card marked disputed is contested: say so when you rely on it.
5. For sources other than the hub (Jira, Koi, Confluence): `ctx sources`, then `ctx howto <source>` for that tool's syntax; call that tool directly.
6. Stop after three searches. Say what was not found; do not invent an entry.
