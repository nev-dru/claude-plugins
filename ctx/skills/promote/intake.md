# Intake guide: where a piece of context goes

Read this before routing any lesson, note, decision or fact. Every piece of context has exactly one home. Put it in the wrong layer and it is either loaded when nobody needs it (wasted tokens on every session), missing when someone does (re-derived from code), or drifting out of date (nobody reviews it where it sits).

## Decide in this order (first yes wins)

| # | Ask | If yes → | Where it is written |
|---|---|---|---|
| 1 | Is it about the task in progress — a plan, a TODO, what was tried, what is left? | **L7 working state** | Plan file, TODO list, MR/PR description, the ticket. Nothing in ctx. |
| 2 | Must it *always* or *never* happen, and can a tool enforce it? ("never push to main", "never read .env") | **Enforcement** | Permission deny rule or hook in `.claude/settings.json`; L1 gets at most a one-line pointer to it. |
| 3 | Is it a secret, a credential, customer data, or restricted information? | **Reject** | Nowhere. Say so. |
| 4 | Is it about **one person** (the user), not the team? Then pick the personal home: | | |
| 4a | …an instruction every session should follow, in every project ("answer concisely", "never use emoji")? | **Global CLAUDE.md** | `~/.claude/CLAUDE.md`. Propose the exact line; the user confirms. Keep it short: it loads in every session. |
| 4b | …an instruction for this repo only, personal (not for teammates)? | **CLAUDE.local.md** | The repo's `CLAUDE.local.md` (git-ignored). Propose the exact line; the user confirms. |
| 4c | …a fact or preference about the user that matters in many projects but only sometimes (hobbies, schedule, how their manager likes reports, tools they prefer)? | **Personal layer** | `ctx new --local <preference\|fact\|note> "<title>"`, fill the file, then `ctx local refresh --background`. Searched by `ctx search` from every project; never published. |
| 4d | …something learned while working in this one project (its quirks, the user's habits there)? | **L6 Claude project memory** | Claude Code's own memory for this project (it writes it); the personal layer's project map points other sessions at it. |
| 5 | Does every session in this repo need it, as one line — an exact command, a repo-wide prohibition, a version warning, a gotcha that bites everyone? | **L1 standing instructions** | `AGENTS.md` (owners approve via MR). Never model-written: propose the line, a human adds it. |
| 5b | Is it **research** — sources read, options compared, findings for a question being planned or designed? | **Repo research doc** | `docs/research/YYYY-MM-DD-<topic>.md` in the project's repo, frontmatter `title`, `date` (when researched), `question`, `status` (current/superseded), `sources` (each with the date read). Indexed into the personal layer, so any session finds it with its age. Its durable *conclusions* are routed again with this table (usually step 9 or step 6), citing the file and keeping its date. |
| 6 | Would it have to change in the same commit as this repo's code — architecture, module layout, where code goes, commands beyond the everyday ones, test or CI setup, this repo's own ADRs? | **Repo reference docs** | `docs/<topic>.md` in the repo, plus one link line in AGENTS.md: `- <topic>: docs/<topic>.md (read when <trigger>)`. |
| 7 | Does doing it need a script or a tool call, not just knowledge? | **L4 procedure** | A skill (SKILL.md + scripts) in a plugin; humans review via MR. |
| 8 | Is it already authoritative somewhere else — a Confluence page, a Jira ticket, an API's own docs, a code graph? | **L5 external source** | Leave it there. Declare the system once in `sources.yaml` + `howto/<name>.md` if it is not declared yet. Add a hub `reference` entry only when it must surface for certain file paths. |
| 8b | Is it true only on one particular computer — its folder layout, hardware and memory, the tools one person installed, or one person's list of repos? | **Personal layer** | `ctx new --local fact "<title>"`. If a general rule sits inside it ("any repo in an iCloud-synced folder…"), that rule can still go to the hub, written machine-independently (L3 below); the specifics stay personal. |
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
- **Belongs:** decisions and their why when they constrain more than one repo, team conventions, gotchas about shared tools, services or a *kind* of machine setup (any Mac syncing ~/Documents to iCloud), never about one particular machine; incident lessons, runbooks for shared systems, references that must be path-routed.
- **Signals:** "we decided", "our convention", "this bit us on two projects", "anyone using X should know".
- **Kinds:** `decision` (with sources), `convention`, `gotcha` (with applies_to), `how-to`, `runbook` (with applies_to), `reference` (with sources).
- **Lifecycle:** replacing an entry → `supersedes:` + old one `deprecated`; contested → `disputed` with evidence; never edit without evidence.
- **Machine-independent:** every teammate's machine differs, so before writing an entry rewrite: home paths and one person's folder layout → placeholders (`<repo>`, `<synced folder>`, `<new root>`); one person's list of repos or tools → a count, or nothing; hardware, memory and locally installed tools → the condition that triggers the problem ("when Docker Desktop holds port 4317"). Keep a measurement only when it describes the shared tool, not the machine it ran on. The specifics, if worth keeping, go to the personal layer.
- **Example:** "Imports of rufalo.* vanish after uv sync: iCloud hides .pth files" — a gotcha about a kind of machine setup (any Python repo in an iCloud-synced folder), not about one machine.

### L4 — Procedures (skills)
- **Belongs:** work that needs a script, a tool call or a fixed sequence the model must execute: `promote`, a release checklist with commands, a migration helper.
- **Signals:** "run these steps", "generate", "check with a script".
- **Not here:** prose procedures without tooling (→ hub `runbook`/`how-to`, which carries review dates and supersession).

### L5 — External sources (Jira, Confluence, Koi, vex indexes, code graphs)
- **Belongs:** nothing is copied in. The system stays authoritative; ctx only describes it (`sources.yaml`, `howto/`).
- **Signals:** the answer already lives in a ticket, a wiki page, an API's docs or an index.
- **Team or personal:** a tool the team shares → hub `sources.yaml`; an index on one machine → `~/.config/ctx/sources.yaml`. See the hub's `docs/adding-sources.md`.

### Personal instruction files (global CLAUDE.md, CLAUDE.local.md)
- **Belongs:** instructions, not facts. Global: how the user wants every session to behave, in every project. Local: the same, for one repo, personal.
- **Signals:** "always", "never", "from now on", "in every project", "in this repo I want".
- **Not here:** facts about the user (→ personal layer), team rules (→ AGENTS.md or hub), anything a hook can enforce (→ hook).
- **Budget:** global ≤ ~2k tokens (it loads in every session everywhere); local ≤ ~500 tokens.
- **Example (global):** `- Lead with the answer; prefer prose over decorative structure.`

### Personal layer (`ctx new --local`)
- **Belongs:** anything about the user that should follow them across projects but is only needed sometimes: preferences, schedule, hobbies, people they work with and how, tools they like, where their projects are (generated), pointers to each project's Claude memory (generated).
- **Signals:** "remember that I …", "for future reference", "I usually …", "my manager …".
- **Not here:** team knowledge (→ hub), secrets (→ nowhere), instructions every session must follow (→ global CLAUDE.md).
- **Example:** `preference` — "Weekends are for trail running; never schedule anything on Saturday mornings."

### L6 — Claude project memory
- **Belongs:** what was learned while working in one project — its quirks, how the user works there. Claude Code writes it; the personal layer's project map points other sessions at it.
- **Not here:** facts about the user that matter across projects (→ personal layer), instructions (→ CLAUDE.md files), team facts (→ hub), secrets (→ nowhere). Keep MEMORY.md under 60 lines; topic files hold the detail.

### L7 — Working state
- **Belongs:** the task: plan, TODO, decisions taken *for this task*, what is left, MR description, ticket comments.
- **Leaves L7 only when** a lesson recurs or outlives the task: then route it with the table above.

### Research (`docs/research/`)
- **Belongs:** the working evidence behind a plan or design: what was read, compared and found, with dates. Long and specific; not loaded anywhere until searched.
- **Always dated:** the filename starts with the research date and the frontmatter repeats it; each source carries the date it was read. Search cards show the age and flag research older than 90 days.
- **Superseding:** newer research on the same question gets a new dated file; the old one gets `status: superseded` and a line naming the newer file and why.
- **Conclusions move on:** a cross-repo decision becomes a hub `decision` whose `sources` include the research file's git URL and whose `date` is the research date; a fact about an external tool becomes a hub `reference` or `gotcha`; something tied to one repo goes to that repo's docs or ADR.

## Moving context between layers

| From → to | When |
|---|---|
| L7 → L6/L3/repo docs | A lesson outlives the task (second occurrence, or clearly durable). |
| research → L3/repo docs | A research doc reaches a conclusion others will rely on: promote the conclusion, cite the file, keep its date. |
| L6 → L3 | The same lesson turns out to matter to others (second occurrence) — `/ctx:promote`. |
| L1 → repo docs | AGENTS.md is over its 2k budget, or a section is reference rather than rule: move it, leave one link line. |
| L3 → repo docs | A hub entry turns out to describe one repo's code: move it into that repo's `docs/`, mark the hub entry `deprecated` with a pointer to the file. |
| repo docs → L3 | A repo fact becomes a team rule other repos follow: write a hub `convention`, link the repo doc as its source. |
| prose → enforcement | A "never" keeps being broken: turn it into a deny rule or hook, shrink the prose to a pointer. |

## Upkeep of the instruction files

Every session review also reads `~/.claude/CLAUDE.md` and the repo's `CLAUDE.local.md` (and AGENTS.md when it is over budget) and proposes exact diffs for:
- **duplicates** — the same rule twice, or a rule the other file already states;
- **contradictions** — two lines that cannot both be followed (keep the newer, ask if unsure);
- **stale lines** — commands, paths or tools that no longer exist (check before proposing);
- **misplaced lines** — a fact about the user (→ personal layer), a team rule (→ AGENTS.md or hub), a "never" a hook can enforce (→ hook);
- **size** — over budget: move detail out and leave one line.

Nothing is changed without the user confirming the exact diff. With `--auto`, upkeep is skipped: these files are personal and never go into a hub PR.

## Ties and edge cases
- **Both repo and team?** Detail in repo docs; a short hub entry (`reference`) that points to it if other repos must discover it.
- **Applies to one directory of one repo?** A nested `AGENTS.md` in that directory, or a hub entry with a `path:` glob (which generates the L2 rule) — prefer the nested file when it changes with that directory's code.
- **Not sure it is durable?** Leave it in L7/L6 and wait for a second occurrence.
- **Disagreement between two sources?** Do not overwrite: mark the hub entry `disputed` with both views and the evidence.
