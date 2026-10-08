---
name: search
description: Search the context layers with ctx — the team hub (decisions, conventions, gotchas, runbooks, project catalog) and this machine's personal layer (personal notes, where projects live, Claude memory from every project). Use when asked about a project, a tool, the user or earlier work; when asked what the hub or "our context" contains, about project instructions, conventions, standards, how we do something, or why a decision was made; when a task touches an area that may already be written down; and when a pointer names an entry ID. Search before re-deriving from code.
allowed-tools: Bash(ctx *)
---
Run searches with the `ctx` command (on PATH). It returns cards: `[ID] title (kind · scope · date)` and a summary.

0. Asked what the hub contains? `ctx list` prints every active entry grouped by scope. Everything about one project: `ctx list --repo <repo>` (entries tagged `repo:<repo>` or a `path:<repo>//…` glob); a theme across repos: `ctx list --label domain=<x>` or `--label initiative=<y>`.
1. `ctx search "<the question in plain words>"` (limit 10). Read the cards. When the question is about the repo you are working in and the hub is large, add `--repo <repo>` to search only its entries (a scoped search leaves out personal results).
2. If nothing fits, retry once with one identifier from the task (an error string, service name, env var, file path): `ctx search "<identifier>"`.
3. Open the best card: `ctx get <ID>` (card, summary, section names). Read a section only if the summary cites the answer: `ctx get <ID> --section <name>`. Use `--full` only when the whole entry is needed.
4. A card marked superseded names its replacement; use that ID. A card marked disputed is contested: say so when you rely on it.
5. For sources other than the hub (Jira, Koi, Confluence): `ctx sources`, then `ctx howto <source>` for that tool's syntax; call that tool directly.
5b. Cards labelled `personal` come from this machine only: personal entries, the project map (where each repo lives here, with pointers to its Claude memory files) and Claude memory files from any project. Read one with `ctx get <ID or path>`. They are unreviewed; prefer a team entry when both answer. Research, spec and plan cards show their date and age; say the date when you rely on one, and re-check anything flagged ⚠ (older than 90 days) against current sources.
6. Stop after three searches. Say what was not found; do not invent an entry.
7. If an entry told you something that proved false in this session (a command failed, a path did not exist, a value was wrong), record it with the evidence: `ctx feedback <ID> wrong --note "<what happened>"`. Do not record "useful"; usefulness is measured from what you do with the entry.
