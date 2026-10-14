---
name: search
description: Search the context hubs with ctx — the team hub (decisions, conventions, gotchas, runbooks, project catalog), project hubs, this machine's personal notes and project map, Claude memory from every project, research in local repos, and any local search tool registered as a hub. Use when asked about a project, a tool, the user or earlier work; when asked what the hub or "our context" contains, about project instructions, conventions, standards, how we do something, or why a decision was made; when a task touches an area that may already be written down; and when a pointer names an entry key. Search before re-deriving from code.
allowed-tools: Bash(ctx *)
---
Run searches with the `ctx` command (on PATH). It returns cards: `[key] title  (kind · scope · date · age)` and a summary. The key names the hub: `team/01M…` (reviewed team knowledge), `personal/…`, `claude-memory:<path>`, `repo-docs:<repo>/docs/…`, `<project-hub>:<path>`, `<query-hub>/<id>`.

0. Asked what the hubs contain? `ctx list` prints every note grouped by hub and scope; `ctx hub list` names the hubs. Everything about one project: `ctx list --repo <repo>`, or `ctx list --hub <project-hub>`; a theme across repos: `ctx list --label domain=<x>`.
1. `ctx search "<the question in plain words>"` (limit 10). Read the cards. To search one hub add `--hub <name>`; when the question is about the repo you are working in and the team hub is large, add `--repo <repo>` (a repo-scoped search leaves out vector and query hubs).
2. If nothing fits, retry once with one identifier from the task (an error string, service name, env var, file path): `ctx search "<identifier>"`.
3. Open the best card: `ctx get "<key>"` (card, summary, section names; a short note shows whole). Quote the key: notes in vaults have spaces in their paths. Read a section only if the summary cites the answer: `ctx get "<key>" --section <name>`. Use `--full` only when the whole entry is needed.
4. A card marked superseded names its replacement; use that key. A card marked disputed is contested: say so when you rely on it.
5. For sources other than the hubs (Jira, Koi, Confluence): `ctx sources`, then `ctx howto <source>` for that tool's syntax; call that tool directly.
5b. Only `team/` cards are reviewed. Personal, Claude-memory, repo-docs and project-hub notes are unreviewed; prefer a team card when both answer. Every card shows its age; ⚠ after the age means it is older than its kind's threshold (research after 90 days): say the date when you rely on one, and re-check flagged ones against current sources.
6. Stop after three searches. Say what was not found; do not invent an entry.
7. If an entry told you something that proved false in this session (a command failed, a path did not exist, a value was wrong), record it with the evidence: `ctx feedback <key> wrong --note "<what happened>"`. Do not record "useful"; usefulness is measured from what you do with the entry.
