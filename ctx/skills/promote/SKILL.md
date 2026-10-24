---
name: promote
description: Review this session for durable lessons and corrections (no argument), or file one piece of context (with an argument). Routes each one to the right place — a hub (the team hub, a project hub, a topic hub or the personal hub), repo docs, or the CLAUDE.md files — and publishes confirmed hub notes. Use when the user says "add this to my project context", "save this to <hub>", "remember this for the team", or asks to promote, file or record something.
allowed-tools: Bash(ctx *) Bash(ctx-promote *) Bash(date *) Read Edit(~/.config/ctx/**) Write(~/.config/ctx/**) Edit(./docs/**) Write(./docs/**) Edit(./AGENTS.md)
---
Two modes: interactive (the user is here and confirms) and `--auto` (the session-close run; nobody confirms).

Hub writes go through `ctx place` (which hub, its format, the scans) and `ctx-promote` (git). `ctx place session` prints this session's folder: `items.json` and `plan.json` go there; `ctx-promote cleanup` clears it.

```
ctx place signals                                    # reads <session>/items.json: per item, candidate hubs and their facts
ctx-promote start <hub>                              # per git hub you will write: prints the checkout to write into
ctx place apply --dir <hub>=<checkout> …             # reads <session>/plan.json: writes each row, all or nothing
ctx-promote commit <hub> <checkout> "<message>"      # scans, validates, commits only what apply wrote
ctx-promote publish <hub> <checkout> main            # interactive: push
ctx-promote publish <hub> <checkout> pr <slug> "<title>" <body-file>   # --auto, main team hub only: draft PR
ctx-promote cleanup <hub> <checkout>                 # always, per hub started, also when you stop early
```

## With an argument: file one item
`/ctx:promote <what>` — one candidate: route it (step 4), then step 5 with a one-row list (or the other destination step 4 names).

## Without an argument: review this session
1. List what this session used: `ctx report --session current`. Note entries marked suspect or wrong, and the zero-result searches (missing entries).
2. Scan the conversation and `MEMORY.md` for durable lessons: a decision made, a gotcha hit twice, a convention someone stated, a runbook step that was missing, research done this session (it belongs in a dated `docs/research/` file; its conclusions are candidates), and things the user said about themselves or how they work. Keep team and personal items in separate lists.
3. Propose every durable candidate — there is no count limit. Durable means another session (or teammate) would act differently because of it; drop one-off facts. For each, search first (`ctx search "<its title>"`): a matching note makes the candidate an update to it. Present one numbered list grouped by destination, one line each with the reason and a ★ on the ones you recommend; hub rows carry their hub and flags (step 5). In interactive mode, stop and let the user reply (step 5d). With `--auto`, take every team candidate and start each factual sentence you could not verify with `CONFIRM:`.
4. Route each candidate with the intake guide: read `intake.md` next to this skill (decision table first, layer details when unsure). Hub layers: the team hub (row 9), a project hub (row 5a), the personal hub (rows 4c, 8b). Other destinations:
   - **Repo docs** (step 6), and, only after the user confirms the exact line, the **global `~/.claude/CLAUDE.md`** or the repo's **`CLAUDE.local.md`**.
   - Say what to do instead for the rest: L7 → leave it in the plan/MR; enforcement → propose the deny rule or hook; L1 → propose the exact AGENTS.md line; L4 → propose the skill; L5 → leave it in the source system; L6 → leave it in Claude's project memory; secret → reject.
   - With `--auto`: team hub rows only. Never write personal destinations or instruction files, and never put personal content (CLAUDE.md lines, memory, personal notes) in an entry or PR body.
4b. Upkeep (interactive only): read `~/.claude/CLAUDE.md` and the repo's `CLAUDE.local.md` (if present) and apply the checklist in `intake.md` ("Upkeep of the instruction files"). Show each proposal as an exact diff with its reason; apply only the ones the user confirms. With `--auto`, skip upkeep.
5. **Hub step**, for every candidate whose layer is a hub:
   a. Write `<session>/items.json`: `[{"key": "3", "layer": "team|project|personal", "title": "…", "text": "the full text you would file", "refs": ["jira:ORB-412", "repo:orbit-sync"], "origin": "conversation | <note key> | <url>"}]`. `refs` are the tickets, repos and components the item names.
   b. `ctx place signals`. Per item, pick one or more hubs from `guess_pool` using each candidate's `belongs` (for `intake.md: …`, that section of intake.md), `applies_to` matches, `similar` notes (a close match may mean an update), `cwd_inside` and `read_this_session`. Nothing fits → `fallback`, shown as `(no match, default)`; a weak guess → `(weak match)`. Never suggest creating a hub.
   c. Flags: ⛔ for each `scan` hit of the chosen hub (rule and line); ⚠ `widens from private` when that candidate's `widens` is true; ⚠ with a one-line reason for anything you judge sensitive (customer data, a teammate's personal details, content from a restricted source); ✋ when its `confirm` is `every-change`. You may add ⚠; you never remove a ⛔.
   d. Each hub row reads `N. <title> → <hub>[ + <hub>] <flags>`, e.g. `3. Retry budget is 7 attempts → orbit`, `5. SQLITE_BUSY needs busy_timeout → team ⚠ widens from private`, `7. Orbit token rotation → orbit ⛔ secret (generic-api-key, line 4)`, `8. Release checklist owner → orbit ✋ confirm`. Replies:
      - `go` or `★`: every row with no ⛔, no widen, no ✋ and no ⚠ on a team-visibility hub.
      - A selection (`1,3,5-9`) or `all`: those rows; it is also the explicit pick a ✋ row needs. It never accepts a ⛔, a ⚠ or a widen.
      - `yes N`: accepts row N's ⚠ or widen, and gives a ✋ row its explicit pick. Only the user's own words count; never infer it.
      - `N → hub` or `N → hub + hub`: change the hub(s); several hubs write linked copies.
      - `redact N`: put the row's hit fingerprints in `redact`. `allow N <reason>`: a false positive; put `{fingerprint, reason}` in `allows` (the reason goes into the commit). Only on the user's own words. `drop N`.
      - `show N`: print the row's exact text for each hub, then ask again.
      - **Never skip a row silently.** After every reply, list each hub row the reply left out with the reply that takes it, e.g. `Skipped: 3 ✋ needs a pick (yes 3) · 7 ⛔ secret (redact 7 / allow 7 <reason> / drop 7) · 9 ⚠ widens from private (yes 9)`, and ask again. Go on to step e when every row is accepted or dropped, or the user says `done` (the rest are dropped; say which).
   e. Write `<session>/plan.json`, one row per accepted item: `[{"key": "3", "op": "new|update|supersede|dispute", "target": "<key, for update, supersede and dispute>", "copies": [{"hub": "orbit", "kind": "<a kind that hub has>", "title": "…", "body": "…", "fields": {…}}], "confirmed": <true only when the user named the row: yes N, a selection or all>, "redact": [], "allows": []}]`. Write each copy in its hub's own style with the same facts: a team entry is terse and machine-independent (intake.md, L3; `fields`: `summary` ≤300 characters, `owners`, `applies_to`, `sources` as kinds.yaml requires); a project or topic hub follows its HUB.md (`ctx hub show <hub> --field root`, then read its HUB.md: folders, required fields, filing rules); personal: `summary`.
   f. For each git hub in the plan, `ctx-promote start <hub>` prints its checkout. Run `ctx place apply --dir <hub>=<checkout> …` (a `--dir` for each managed clone; the user's own checkouts need none). Refused rows say why: fix the plan or ask, then apply again. Never edit hub files by hand.
6. Repo docs (interactive only): add the fact to the matching file under the repo's `docs/` (create `docs/<topic>.md` if none fits), and if the file is new, add one line to AGENTS.md: `- <topic>: docs/<topic>.md (read when <trigger>)`. Leave the change uncommitted for the user's next commit. With `--auto`, list these candidates in the PR body under "Belongs in <repo>/docs".
7. Publish each git hub apply wrote: `ctx-promote commit <hub> <checkout> "promote: <n> notes — <titles>"`, then:
   - **Interactive**, by `ctx hub show <hub> --field confirm`: `never` or `every-change` → `ctx-promote publish <hub> <checkout> main`; `before-sharing` (the default for team hubs) → ask once at the end, `push <hub> (<n> notes)?` with the titles, publish on yes; on no, say the commit waits and `ctx-promote push <hub>` sends it later (`ctx status` lists it). Print each SHA.
   - **`--auto`**, main team hub only: write the candidate list and evidence to `<checkout>/.promote-body.md` (add "Drafted automatically at session close; review before merging."), then `ctx-promote publish <hub> <checkout> pr <short-slug> "promote: <n> entries, <m> corrections" <checkout>/.promote-body.md`. Print the PR URL. Rows apply skipped (they widen from a private hub) wait for the next interactive review: give their count, never their text.
   - A failed push is kept (`ctx status` shows it pending or unpushed): tell the user, and that `ctx-promote push <hub>` retries. The personal hub has no git step: apply already wrote it.
8. Corrections: for a suspect or wrong entry with evidence from this session, a `dispute` row (target its key; one copy for its hub whose body is the evidence). A replacement is a `supersede` row. Never edit an entry without evidence from this session.
9. Always finish with `ctx-promote cleanup <hub> <checkout>` for each hub you started, also when you stop early: it keeps unpushed work and clears the session folder.

If nothing durable happened, say so and stop; an empty review is a correct result. Never file secrets, customer data or anything restricted.
