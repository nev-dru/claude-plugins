# ctx — team context for Claude Code

A plugin (skills + a mod) over the `ctx` CLI and a team knowledge hub. It puts the right reviewed entry in front of the model when a file, error or question calls for it, shows you live what context is in play, and measures whether it earned its place.

## How the model learns the hub exists

Installing the plugin is enough; no AGENTS.md line is needed. On the first prompt of every session (and again after a compaction) the mod adds one line to the model's context: `Team knowledge hub (ctx): 15 active entries — rufalo 7, agents 2, … Before answering about conventions, decisions, setup, project instructions or "our context", run ctx search … (or ctx list)`. It is built from `ctx status`, so it stays current as the hub grows, and costs about 60 tokens per session. Later prompts that ask about the hub, conventions, decisions or "how do we …" get a one-line search hint.

## Other sources (L5)

ctx describes other sources but never wraps them; the model queries each tool directly after `ctx howto <name>`.

- **Team sources** live in the hub's `sources.yaml` (Jira, Confluence, Koi). Each names the binary it `requires`; a source whose binary is not installed is hidden on that machine.
- **Personal sources** live in `~/.config/ctx/sources.yaml` with howtos in `~/.config/ctx/howto/` — local indexes, notes, code graphs. They are never published. A team entry of the same name always wins.
- The session pointer lists every source available on this machine; `ctx sources` shows all of them, installed or not.
- When a Bash command queries a source (its binary, plus `match:` text when several sources share one), the feed shows it and `ctx report` counts it under `sources`.

Step-by-step guide with the full field reference: `docs/adding-sources.md` in the hub repository.

Example personal entry:

```yaml
claude-docs:
  description: Claude Code and Anthropic docs (local vex index). Use for how Claude Code works.
  kind: index
  requires: vex
  match: anthropic-sdlc-docs     # text that identifies this source in the command
  howto: howto/claude-docs.md    # under ~/.config/ctx
```

## What you see

**Band** (one line above the prompt): `ctx · pointers 3 · used 1 · feed 12 · index a002757` — pointers injected this session, entries fetched, feed events, the installed index build. `· compacted` appears after a compaction; `· lessons? /ctx:promote` appears once a session has five of your turns and at least one lookup or pointer.

**`/ctx`** opens a compact live pane (10 rows; `Esc` or `/ctx close` closes it):

```
ctx · index 729b50c · 0d · 15 entries · review due 0
L1 3.7k · L2 6 rules · L3 1 used/3 found · L5 claude-docs 1 · L6 MEMORY 4/60 · L7 4 files
✓ reused  6N  Python is pinned to 3.12
offered   6Q  Prompt cache: build_prefix assembles the stable prefix…
04:37 search "python version" → 6N 6P ×2
04:32 hub pointer injected (15 entries)
```

- Line 1: the installed index, its age, active entries, entries past their review date.
- Line 2, one number per layer: L1 standing instructions (tokens of AGENTS.md/CLAUDE.md in this repo), L2 path rules, L3 hub entries used/found this session, L5 queries per other source, L6 MEMORY.md lines against the 60-line cap, L7 files read.
- Entries in play (up to four): `✓ reused` (its terms appeared in a later edit or command), `✗ suspect` (a command using it failed), `used` (`ctx get`), `found` (search hit), `offered` (pointer).
- The newest events; a repeat bumps `×n` instead of adding a line. Empty sections are not shown.

**`/ctx explain`** prints this session's `ctx report` into the transcript.

## How usefulness is measured

Nothing asks the model "was that useful"; self-reports skew positive. Every entry climbs a ladder of deterministic signals instead:

| Signal | Meaning | Source |
|---|---|---|
| offered | a pointer was injected for a file in the prompt or a file read | `prompt.submit`, Read/Grep/Glob |
| found | it came back from `ctx search` | Bash tool result |
| used | the model fetched it with `ctx get` | Bash tool result |
| reused | a distinctive term from the fetched entry (identifier, path, flag, env var) appeared in a later Edit/Write/Bash | `ctx feedback <ID> reused` |
| suspect | a failing command used one of its terms | `ctx feedback <ID> suspect --note "<error>"` |
| wrong / stale | the model found it false and says why | `ctx feedback <ID> wrong --note "<evidence>"` (search skill step 7) |

`ctx report` ranks entries: **proven** (reused), **ignored** (offered 3+ times, never fetched — pruning candidates), **suspect/wrong** (to dispute or fix). The one rigorous measure stays the with/without eval (phase 2); these are the live proxies.

## Staying current across sessions

Every session on a machine reads the same local index (`~/.config/ctx/hub/index.db`), so one sync updates them all.

- **Session start, then every 5 minutes** (on your next prompt): `ctx sync --if-newer --no-views` asks GitHub for a newer release and installs it only if the corpus changed. It never writes into your repo.
- **Every prompt:** a ~10 ms local check notices an index installed by any session; the feed shows `index b1 → b2 (+2 entries)` and the model is told once that the hub changed.
- **Right after a promote push:** the skill rebuilds the index from your hub checkout and installs it immediately (`ctx sync --from`), so you don't wait for CI.
- Syncs stage in private folders and swap the index in with one rename; a search that lands mid-swap retries.

`ctx sync` with no flags still also rewrites the repo's `docs/ctx/INDEX.md` and `.claude/rules/ctx-*.md`; run it when you want those refreshed.

## Skills

- `/ctx:search` — the search loop (`ctx search` → `ctx get` → section), with the rule to flag false entries with evidence.
- `/ctx:promote <lesson>` — route one lesson; a hub entry is committed and pushed straight to main (undo with `git revert`).
- `/ctx:promote` (no argument) — review this session: lists what was used, proposes every durable lesson (no count limit; duplicates become updates), grouped by destination for you to pick, turns suspect/wrong flags into `disputed` corrections; after you confirm, commits and pushes to main. Empty is a valid result.

## Session-close review (off by default)

`ctx config auto-promote on` makes the plugin's `SessionEnd` hook re-enter a closed session headless (`claude -p --resume <id> "/ctx:promote --auto"`) and draft PRs you review later. Gates: at least five of your turns, at least one `ctx` lookup, once per session, never inside a review run. It spends model tokens (roughly $0.05–0.30 per qualifying session, inputs are prompt-cached), so it stays opt-in. `ctx config auto-promote off` turns it back off. Logs: `~/.config/ctx/sessions/<session>.review.log`.

## CLI (on the Bash PATH inside Claude Code)

`ctx list [--all] [--repo R] [--label facet=value]… [--kind K]` · `ctx search "q" [--repo R] [--label facet=value]… [--kind K] [--path GLOB] [--limit N] [--history] [--json]` · `ctx get ID [--section H | --full] [--max-tokens N]` · `ctx related ID` · `ctx route --files …` · `ctx sources` · `ctx howto SOURCE` · `ctx sync [--check]` · `ctx status [--json]` · `ctx report [--today] [--json] [--session current]` · `ctx feedback ID|source:NAME reused|suspect|wrong|stale|ignored [--note TEXT]` · `ctx config auto-promote on|off` · `ctx new KIND "title"`.

`bin/ctx` is a shim that downloads the pinned release binary (`bin/ctx.version`) from the hub and verifies its checksum. The hub is private; `gh` must be authenticated.

## Requirements

Claude Code with mods enabled, `gh` logged in to an account that can read the hub repository, `bash`, `shasum` or `sha256sum`.
