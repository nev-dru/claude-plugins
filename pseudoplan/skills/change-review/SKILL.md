---
name: change-review
description: >
  This skill should be used when the user asks to "review this PR", "review this branch", "review this diff",
  "help me understand this change", "diagram what changed", "map this change", or wants to review code that
  already exists, written by someone else or by an agent. It maps a git diff into the pseudocode plan format
  with every function anchored to real file lines, proves with a checker that no changed line was left out,
  opens the flow diagram with the real code attached, and collects the reviewer's comments.
metadata:
  version: "0.6.0"
---

# Change review

Turn a diff into something a reviewer can understand in minutes: the flow of the changed code, what it touches,
what crosses a boundary, and what happens when things fail, with the real code one click away. The format, the
page and the tool are the same as for the `pseudocode-plan` skill. The difference is direction: the plan
describes code that exists, and a checker holds it against the real diff so nothing can be left out or glossed.

The tool is `../pseudocode-plan/scripts/plan-review.cjs` relative to this skill (Node 18+). Below: `plan-review`.
The format is in `../pseudocode-plan/references/format.md`; read its "Review mode" section first.

## Workflow

1. **Fix the range.** Ask only if it is unclear. Usual choices: `main...HEAD` for a branch, `HEAD` for uncommitted
   work, `<base>...<head>` for a PR checked out locally. Run `plan-review hunks <range>` from inside the repo to
   list every changed file and line range.
2. **Read the change and its surroundings.** Read every changed function in full, plus the callers and callees
   needed to understand it. Do not describe code from its diff hunk alone.
3. **Write the review plan** at `plans/<short-slug>-review.plan`, with `diff: <range>` at the top.
   - Divide the changed files into 3 to 7 areas of responsibility and put a `group Name` line above each set
     (`group tracing`, `group ledger`, `group HITL loop`). The diagram draws one lane per group, so a reviewer
     sees what each cluster of functions is for even when nothing in the diff calls it. One file per group is
     fine; a group per file is not, unless the files really are that independent.
   - Pick the altitude first. Top-level `fn` lines are the main execution path only: what a reader would draw
     on a whiteboard, usually 5 to 12 boxes. Every other changed function is `part of` the function that uses
     it (`+ fn attrs_json() @ 60-70 part of record_tool_result`). Read the real callers to decide; a helper
     called from unchanged code is `part of` the nearest changed function on that path, or `[entry]` if it
     really starts a path of its own. `check` refuses a top-level function that nothing reaches.
   - Every changed function gets `+` or `~`, an anchor `@ start-end` (new-side lines, whole function), and a
     `// one-line summary` of what it does. The summary is the label the sequence diagram shows when a group
     is collapsed, so write it as the sentence a reader needs at that altitude.
   - Give body lines their own `@ line` anchors wherever a step maps to specific lines. These let the reviewer
     jump from a step to its code, and let scenario walks highlight the real lines.
   - Changed code outside functions (imports, constants, config, schema) goes in a `region`.
   - Unchanged functions the change calls into appear as signatures with `// unchanged`, anchored if in the repo.
   - Generated or irrelevant files go under `ignore:`. Use it sparingly and never to hide something hard.
   - Describe what the code does, not what the commit message says it does. Where they differ, that is a finding.
   - Tag side effects, declare channels for boundary crossings, and record changed data shapes, as in planning.
4. **Check until clean:** `plan-review check <plan>`. Coverage errors mean a changed line is not described:
   describe it. Anchor errors mean line numbers are off: re-read the file and correct them. Do not open the
   review with errors. Warnings about the code itself (an unhandled throw, a write plus an emit with no outbox)
   stay: they are findings for the reviewer.
5. **Tell the main run as a story.** The first `trace` is one real run of the changed code, end to end, 8 to 20
   steps in execution order, every step with a state sentence and an `@` anchor on the line it names. The
   reviewer reads it top to bottom in the Story tab with the real lines under each sentence; that is how they
   understand the change, so write the sentences for a reader who has not seen the code. `check` warns on
   steps with no state and on a first scenario that is too short to be a run.
6. **Put findings where the reviewer will see them.**
   - A suspected bug becomes a scenario that walks the real lines to the failure, with `!` on the step where it
     goes wrong. One honest failure scenario is worth more than a paragraph of concern.
   - A question only the author or reviewer can answer becomes a `??` on the line it concerns, with WHY, the
     ASSUMED reading, and an ALT reading with its consequence.
   - Do not soften. Do not pad with style remarks. Flow, contracts, failure paths and data shapes first.
7. **Open and wait:** `plan-review open <plan>`, then `plan-review wait <plan> --timeout 540`
   (exit 3: run wait again; 2: comments; 0: approved; 4: run open again).
8. **On comments:** answer questions from the code. If a note says the plan misdescribes the code, fix the plan
   file (the page updates live) and wait again. When the reviewer is done, turn their notes into review comments
   for the author: one per note, addressed to file and line, stating the problem, the evidence (the scenario
   step if there is one) and a concrete suggestion. Show the drafts to the user. Post nothing anywhere unless
   the user asks.
9. **On approval:** `plan-review stop <plan>` and report that the change was approved, with any notes left.

## What makes this trustworthy

The reviewer is trusting a description of code they have not read line by line. Earn that:
- The coverage check is the floor, not the goal. It proves nothing was skipped, not that the description is right.
- Anchor generously. Every claim the reviewer can verify in one click is a claim they can trust.
- If part of the change was not understood, say so in a `??`. Never paper over it with confident pseudocode.
