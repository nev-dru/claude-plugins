# pseudoplan

Makes a coding agent show you its design as pseudocode, and lets you review it properly, before it writes code.

The agent writes a small text file: data shapes, contracts between systems, functions as pseudocode with side
effects tagged, open decisions pinned to the line they affect, and step-by-step scenarios including failures.
A checker catches what can be caught mechanically. Then the plan opens on a local web page:

- a flow diagram of the main execution path, in one lane per `group` or `service`; click a box for its
  pseudocode, its contract, and the helpers folded into it with `part of`
- a sequence diagram of the chosen scenario: one lifeline per group, one arrow per step, failures in red. Click a
  group to expand it into its functions, or show every line. The page never moves: the controls stay pinned at the
  bottom of the window and the diagram scrolls inside its own box so the current step sits a third of the way down
- a "This step" panel beside it: the state sentence, the pseudocode line, the whole function with the step's real
  lines highlighted and syntax coloured, and the contract, data shape or resource that line touches
- a Flow view of the same functions for "where does X live", which also lights up as you walk
- "Your call" decisions with the reason, the default and the alternatives, answerable in place
- a Note button on every line, function, file, data shape, contract, scenario and step
- state machines drawn from the plan, showing the current state as you walk a scenario
- a timeline for scenarios where timing matters, with a bar for every lease or TTL showing when it runs out
- a Decisions tab: what is still open, what you have answered, and a dated log of every past decision with
  what was chosen and what was turned down, kept in the plan file itself
- "Finish review" sends everything straight back to the agent. It revises the plan file, and the open page
  updates by itself and outlines what changed. Approve, and it implements exactly that plan, then reports
  any deviation.

## Reviewing a change that already exists

The same page works in the other direction. Ask the agent to "review this branch" and it maps the diff into the
same format, with each function and step anchored to real file lines. The page then shows the real code, with
added and removed lines, under each function (switch between Both, Pseudocode and Real code), highlights the real
lines as you walk a scenario, and takes notes on individual lines of code.

You are trusting a description of code, so a checker holds it against `git diff`: every changed, non-blank line
must be covered by an anchor or explicitly ignored, a function marked unchanged must really be unchanged, and
anchors must point at real lines. The agent cannot open the review until that passes.

    node pseudoplan/skills/pseudocode-plan/scripts/plan-review.cjs hunks main...HEAD   # what changed, by file and line

## Requirements

Node 18 or newer, and git for review mode. No packages to install. The server listens on 127.0.0.1 only.

## Install in Claude Code

Unzip, then from the folder that contains `pseudoplan-marketplace`:

    /plugin marketplace add ./pseudoplan-marketplace
    /plugin install pseudoplan@pseudoplan-local

Then ask for a plan in the usual way, for example "plan this in pseudocode before you code".

## Using the tool by hand

    node pseudoplan/skills/pseudocode-plan/scripts/plan-review.cjs check  my.plan
    node pseudoplan/skills/pseudocode-plan/scripts/plan-review.cjs open   my.plan
    node pseudoplan/skills/pseudocode-plan/scripts/plan-review.cjs wait   my.plan   # prints your review when you send it
    node pseudoplan/skills/pseudocode-plan/scripts/plan-review.cjs stop   my.plan
    node pseudoplan/skills/pseudocode-plan/scripts/plan-review.cjs render my.plan   # standalone HTML, no server

Try it on `skills/pseudocode-plan/examples/order-flow.plan`.

## Keeping the look

There is no separate mockup. The demo page, the `render` output and the live review page are the same
`page.html` and `core.js`, and the typefaces are embedded, so it renders the same offline and on any OS.
`dev/visual-check.cjs` enforces that: it fails if the standalone and live pages differ by a single pixel outside
the agent status badge (light and dark), or if any example drifts from the approved screenshots in `dev/golden/`.
Run it before shipping a change to the page; pass `--update` only when a visual change is intended and approved.
It needs the dev-only `playwright` package. The plugin itself still has no dependencies.

## Files it writes

- `<plan>.review.md` next to the plan: your latest review, as sent to the agent
- two small files in the system temp folder: the server's port, and your unsent draft notes

## Limits

- Checks read tags and keywords. They find omissions, not wrong logic.
- In review mode the coverage check proves no changed line was skipped. It cannot prove the pseudocode describes
  the code correctly; the anchors are there so you can verify any claim in one click.
- A contract for an external system is the plan's claim about it. Nothing compares it with the real schema yet.
- Scenario state is prose written by the agent. Treat it as a claim to review.
- Scenarios are linear, so a walk through a `parallel:` block shows one interleaving.
