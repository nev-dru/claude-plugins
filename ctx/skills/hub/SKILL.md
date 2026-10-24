---
name: hub
description: Register, inspect or change context hubs — add a git repo, a folder (an Obsidian vault, a project context repo) or a local search tool as a hub that ctx search covers; list hubs; make one editable or read-only; stop or start confirmations; remove one. Use when the user says "add this repo/folder as a hub", "register a hub", "what hubs do I have", "make <hub> editable", "stop asking me before writing to <hub>" or "remove <hub>".
allowed-tools: Bash(ctx hub *) Bash(ctx search *) Bash(ctx sync *) Bash(ctx-promote *) Read
---
1. `ctx hub list` first, so you know which names are taken and what exists.
2. A git repo or a folder:
   - If the user has not said, ask one question: read-only or editable? (Read-only is the default.)
   - `ctx hub add <git-url-or-path> [--name <short-name>] [--editable]`. The name defaults to the repo or folder name; a git hub is cloned under ~/.config/ctx/hubs unless `--path <dir>` puts it somewhere the user will open it (an Obsidian vault).
   - If the output shows a drafted HUB.md (the hub had none), show it and ask whether it matches how the hub is organised. On yes: `ctx hub draft <name> --accept`. On corrections, edit the draft file the command printed, then accept.
   - To put an accepted draft into the hub itself (so teammates get it): `ctx-promote start <name>`, `ctx hub draft <name> --commit <checkout>`, then `ctx-promote commit <name> <checkout> "hub: add HUB.md"` and `ctx-promote publish <name> <checkout> main`.
   - Team hubs default to `confirm: before-sharing` (save and commit without asking, one question before pushing). Suggest `--confirm every-change` only when the user wants to pick each row.
   - Finish with `ctx search --hub <name> "<a word from the hub>"` to show it works.
3. A local search tool (a database with a CLI that prints JSON): run the user's sample query once to see its JSON fields, then `ctx hub add --name <name> --query '<command with {q}>' --get '<command with {id}>' --map id=<field>,title=<field>,summary=<field>,path=<field>`. `{q}` and `{id}` must be whole arguments.
4. Changing a hub: `ctx hub set <name> key=value …` — mode (read-only|editable), visibility (private|team), confirm (never|before-sharing|every-change), vectors (true|false), exclude (comma-separated globs), branch, timeout.
5. Removing: `ctx hub remove <name>`. If it refuses because of unpushed or uncommitted work, tell the user what is at stake; pass `--force` only when they say so. A hub at the user's own path is never deleted, only unregistered.
6. Where personal items with no matching hub go: `ctx hub default <name|none>` (default: personal).
Never edit ~/.config/ctx/hubs.yaml by hand; the commands validate it.
