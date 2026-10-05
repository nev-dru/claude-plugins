# Intake guide: where a piece of context goes

Read this before routing any lesson, note, decision or fact. Every piece of context has exactly one home. Put it in the wrong layer and it is either loaded when nobody needs it (wasted tokens on every session), missing when someone does (re-derived from code), or drifting out of date (nobody reviews it where it sits).

## Decide in this order (first yes wins)

| # | Ask | If yes → | Where it is written |
|---|---|---|---|
| 1 | Is it about the task in progress — a plan, a TODO, what was tried, what is left? | **L7 working state** | Plan file, TODO list, MR/PR description, the ticket. Nothing in ctx. |
| 2 | Must it *always* or *never* happen, and can a tool enforce it? ("never push to main", "never read .env") | **Enforcement** | Permission deny rule or hook in `.claude/settings.json`; L1 gets at most a one-line pointer to it. |
| 3 | Is it a secret, a credential, customer data, or restricted information? | **Reject** | Nowhere. Say so. |
| 4 | Is it only useful to one person — a preference, a habit, a local path, how they like answers? | **L6 personal memory** | `~/.claude/projects/<repo>/memory/` (one fact per file, one index line in MEMORY.md). |
| 5 | Does every session in this repo need it, as one line — an exact command, a repo-wide prohibition, a version warning, a gotcha that bites everyone? | **L1 standing instructions** | `AGENTS.md` (owners approve via MR). Never model-written: propose the line, a human adds it. |
| 6 | Would it have to change in the same commit as this repo's code — architecture, module layout, where code goes, commands beyond the everyday ones, test or CI setup, this repo's own ADRs? | **Repo reference docs** | `docs/<topic>.md` in the repo, plus one link line in AGENTS.md: `- <topic>: docs/<topic>.md (read when <trigger>)`. |
| 7 | Does doing it need a script or a tool call, not just knowledge? | **L4 procedure** | A skill (SKILL.md + scripts) in a plugin; humans review via MR. |
| 8 | Is it already authoritative somewhere else — a Confluence page, a Jira ticket, an API's own docs, a code graph? | **L5 external source** | Leave it there. Declare the system once in `sources.yaml` + `howto/<name>.md` if it is not declared yet. Add a hub `reference` entry only when it must surface for certain file paths. |
| 9 | Otherwise: a fact, decision, convention, gotcha or procedure that spans repos or is not tied to one repo's code. | **L3 team hub** | `ctx new <kind>` → draft PR. Its `applies_to` paths generate **L2** pointers automatically. |

Prefer a second occurrence before promoting anything out of L6 or L7: one-off lessons stay where they happened.

## The layers in detail

### L1 — Standing instructions (`AGENTS.md`)
- **Belongs:** tens of rules, must-follow first. Exact commands used every session (`make test`), repo-wide prohibitions, version pins that change code (`Python 3.12 only`), the one link to each reference doc, the three-line memory protocol.
- **Signals:** "always", "every time", "in this repo", a command someone types daily, a mistake every newcomer makes.
- **Not here:** anything scoped to a subdirectory (→ L2 via a hub entry's `applies_to`, or a nested AGENTS.md), explanations and background (→ repo docs or hub), anything a tool can enforce (→ hook/deny rule), anything one person wants (→ L6).
- **Budget:** ≤2k tokens. Over budget means something here is reference material: move it to repo docs and leave a link.
- **Example:** `- Run make lint && make test before every commit; one test: uv run pytest path::name.`

### L2 — Triggered pointers (`.claude/rules/ctx-*.md`)
- **Belongs:** pointer lines only, generated from hub entries' `applies_to: path:<repo>//<glob>`; they load when a matching file is read.
- **Signals:** "when you touch `packages/hitl/**`, know that …".
- **Never hand-written.** To add one, write (or edit) a hub entry with the path glob in `applies_to`; `ctx sync` writes the rule.

### Repo reference docs (`docs/`)
- **Belongs:** knowledge versioned with this repo's code: architecture and where code goes, module responsibilities, the full command set, test layout and fixtures, CI pipeline details, this repo's ADRs.
- **Signals:** it names this repo's files, modules or targets; it would be wrong after a refactor of this repo; reviewers of this repo's MRs should see it change.
- **Not here:** team-wide conventions (→ hub), anything another repo would need (→ hub, with a pointer back if the detail stays here).
- **Why not the hub:** reviewed in the same MR as the code, so it cannot drift; any agent tool (Copilot, OpenCode) reads a linked markdown file without ctx.
- **Example:** `docs/architecture.md` — "Model access goes through `rufalo.providers`; agents never import an SDK directly."

### L3 — Team hub (`entries/<ULID>.md`)
- **Belongs:** decisions and their why when they constrain more than one repo, team conventions, gotchas about shared tools, machines or services, incident lessons, runbooks for shared systems, references that must be path-routed.
- **Signals:** "we decided", "our convention", "this bit us on two projects", "anyone using X should know".
- **Kinds:** `decision` (with sources), `convention`, `gotcha` (with applies_to), `how-to`, `runbook` (with applies_to), `reference` (with sources).
- **Lifecycle:** replacing an entry → `supersedes:` + old one `deprecated`; contested → `disputed` with evidence; never edit without evidence.
- **Example:** "Imports of rufalo.* vanish after uv sync: iCloud hides .pth files" — a machine gotcha that bites any Python repo under iCloud Drive.

### L4 — Procedures (skills)
- **Belongs:** work that needs a script, a tool call or a fixed sequence the model must execute: `promote`, a release checklist with commands, a migration helper.
- **Signals:** "run these steps", "generate", "check with a script".
- **Not here:** prose procedures without tooling (→ hub `runbook`/`how-to`, which carries review dates and supersession).

### L5 — External sources (Jira, Confluence, Koi, vex indexes, code graphs)
- **Belongs:** nothing is copied in. The system stays authoritative; ctx only describes it (`sources.yaml`, `howto/`).
- **Signals:** the answer already lives in a ticket, a wiki page, an API's docs or an index.
- **Team or personal:** a tool the team shares → hub `sources.yaml`; an index on one machine → `~/.config/ctx/sources.yaml`. See the hub's `docs/adding-sources.md`.

### L6 — Personal memory
- **Belongs:** how this person works: preferences, corrections they gave, local paths, their projects and deadlines.
- **Signals:** "I prefer", "for me", "on my laptop", a correction of the assistant's behaviour.
- **Not here:** team facts (→ hub), secrets (→ nowhere). Keep MEMORY.md under 60 lines; topic files hold the detail.

### L7 — Working state
- **Belongs:** the task: plan, TODO, decisions taken *for this task*, what is left, MR description, ticket comments.
- **Leaves L7 only when** a lesson recurs or outlives the task: then route it with the table above.

## Moving context between layers

| From → to | When |
|---|---|
| L7 → L6/L3/repo docs | A lesson outlives the task (second occurrence, or clearly durable). |
| L6 → L3 | The same lesson turns out to matter to others (second occurrence) — `/ctx:promote`. |
| L1 → repo docs | AGENTS.md is over its 2k budget, or a section is reference rather than rule: move it, leave one link line. |
| L3 → repo docs | A hub entry turns out to describe one repo's code: move it into that repo's `docs/`, mark the hub entry `deprecated` with a pointer to the file. |
| repo docs → L3 | A repo fact becomes a team rule other repos follow: write a hub `convention`, link the repo doc as its source. |
| prose → enforcement | A "never" keeps being broken: turn it into a deny rule or hook, shrink the prose to a pointer. |

## Ties and edge cases
- **Both repo and team?** Detail in repo docs; a short hub entry (`reference`) that points to it if other repos must discover it.
- **Applies to one directory of one repo?** A nested `AGENTS.md` in that directory, or a hub entry with a `path:` glob (which generates the L2 rule) — prefer the nested file when it changes with that directory's code.
- **Not sure it is durable?** Leave it in L7/L6 and wait for a second occurrence.
- **Disagreement between two sources?** Do not overwrite: mark the hub entry `disputed` with both views and the evidence.
