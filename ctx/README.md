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

**`/ctx`** opens the live pane beside the transcript (`Esc` or `/ctx close` closes it):

- **Feed** — newest first: `pointer ×2 ← src/pay/client.go`, `search "retry key" → F0A F0C`, `get F0A §`, `read packages/core/cache.py (1 pointer)`, `reuse F0A ← Idempotency-Key`, `suspect F0C ← Exit code 1 …`, `compacted`.
- **In play** — every entry this session touched and how far it got: `offered` (a pointer), `found` (a search hit), `used` (`ctx get`), `✓ reused` (its terms appeared in a later edit or command), `✗ suspect` (a command using its terms failed).
- **Files read** — what Read/Grep/Glob touched, with the pointers that matched.
- **Health** — `MEMORY.md` lines against the 60-line cap, index build and age, entries past their review date, compactions.

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

## Skills

- `/ctx:search` — the search loop (`ctx search` → `ctx get` → section), with the rule to flag false entries with evidence.
- `/ctx:promote <lesson>` — draft one entry and open a draft PR in the hub.
- `/ctx:promote` (no argument) — review this session: lists what was used, proposes 0–3 durable lessons, turns suspect/wrong flags into `disputed` corrections, opens one draft PR. Empty is a valid result.

## Session-close review (off by default)

`ctx config auto-promote on` makes the plugin's `SessionEnd` hook re-enter a closed session headless (`claude -p --resume <id> "/ctx:promote --auto"`) and draft PRs you review later. Gates: at least five of your turns, at least one `ctx` lookup, once per session, never inside a review run. It spends model tokens (roughly $0.05–0.30 per qualifying session, inputs are prompt-cached), so it stays opt-in. `ctx config auto-promote off` turns it back off. Logs: `~/.config/ctx/sessions/<session>.review.log`.

## CLI (on the Bash PATH inside Claude Code)

`ctx list [--all]` · `ctx search "q" [--kind K] [--path GLOB] [--limit N] [--history] [--json]` · `ctx get ID [--section H | --full] [--max-tokens N]` · `ctx related ID` · `ctx route --files …` · `ctx sources` · `ctx howto SOURCE` · `ctx sync [--check]` · `ctx status [--json]` · `ctx report [--today] [--json] [--session current]` · `ctx feedback ID|source:NAME reused|suspect|wrong|stale|ignored [--note TEXT]` · `ctx config auto-promote on|off` · `ctx new KIND "title"`.

`bin/ctx` is a shim that downloads the pinned release binary (`bin/ctx.version`) from the hub and verifies its checksum. The hub is private; `gh` must be authenticated.

## Requirements

Claude Code with mods enabled, `gh` logged in to an account that can read the hub repository, `bash`, `shasum` or `sha256sum`.
