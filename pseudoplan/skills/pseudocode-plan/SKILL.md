---
name: pseudocode-plan
description: >
  This skill should be used when the user asks to "plan this in pseudocode", "write a pseudocode plan",
  "show me the design before you code", "let me review the plan first", "open the plan review", or asks for a
  plan, spec or design for a code change that touches more than one function, crosses a service boundary, or
  changes a data shape or message contract. It writes the plan in a small checkable text format, runs
  deterministic checks on it, opens it in a local review page, and blocks until the human sends back decisions
  and notes. No implementation code is written until the human approves.
metadata:
  version: "0.1.0"
---

# Pseudocode plan

Write the design as pseudocode a developer can review in a minute, get it approved, then implement exactly that.
The reviewer reads code for a living. Task lists and prose hide decisions from them; control flow, data shapes,
contracts and failure walks show decisions to them. The plan is a contract: what gets approved is what gets built.

The tool is `scripts/plan-review.cjs` in this skill's directory (Node 18+, no dependencies). Call it as
`node "<this skill's directory>/scripts/plan-review.cjs" <command> <plan file>`. Below it is written `plan-review`.

## Workflow

1. **Explore before writing.** Read the code the change touches. Every existing function, file, type and channel
   named in the plan must be real, with its real name and signature. A plan written before reading is fiction.
2. **Write the plan file** at `plans/<short-slug>.plan` unless the user names a place. Follow
   `references/format.md`. Two complete examples are in `examples/`. Follow the writing rules below.
3. **Check it:** `plan-review check <plan>`. Fix every error. Fix every warning that has a clear fix. For a
   warning whose fix is a judgment call, put a `??` decision on the line it concerns. Never show the reviewer an
   error the checker already found.
4. **Open it:** `plan-review open <plan>`. This starts a local server and opens the review page. Tell the user
   once, in one line, that the plan is open in their browser and that feedback left there comes straight back.
5. **Wait:** `plan-review wait <plan> --timeout 540`. This blocks until the reviewer finishes. Keep the timeout
   under the shell tool's own limit. Exit codes:
   - `3` nothing yet. Run the same wait again. Do not sleep-poll, do not ask in chat whether they are done.
   - `2` changes requested. The review is on stdout (and in `<plan>.review.md`).
   - `0` approved.
   - `4` the server is gone. Run `open` again, then `wait`.
6. **On changes requested:** read the whole review. If it says the reviewer edited the plan file, re-read the
   file first and keep their edits. Then edit the plan file in place:
   - Decided decision: delete its `??` line and make the pseudocode reflect the choice. The tool has already
     recorded it under `decided:` in the plan file. Never edit that section.
   - Note: address it where it points. If it is a question that cannot be settled from the code, add a `??` there.
   - Failing check: fix it, or make it a `??`.
   - Keep everything else character for character, so the page can show exactly what changed.
   - Keep scenarios in step: every step must still match a line; a new failure path gets its own scenario.
   Run `check` again, then go back to step 5. The open page follows the file and outlines the changes by itself.
7. **On approval:** run `plan-review stop <plan>`, then implement exactly the plan. When finished, compare the
   code to the plan and report every deviation and why. If a deviation changes a contract, a data shape or a
   failure path, stop and put it back through review instead of reporting it afterwards.

## Writing rules

- **Elide the boring, expand the risky.** One pseudocode line stands for roughly 3 to 10 lines of code.
  "validate input, else return 400" is one line. Branches, loops with I/O, concurrency, state changes, failure
  handling and anything crossing a boundary get spelled out.
- **Plain English, no real syntax** in bodies. Real syntax only in signatures and type fields.
- **Mark change honestly.** `+` new, `~` modified, no mark unchanged. Unchanged functions are a signature with
  their tags and `// unchanged`, never a body.
- **Tag every side effect** where it happens: `[db:name]`, `[network:name]`, `[throws]`, `[mutates]`, `[async]`.
  Name the target so it becomes a node the reviewer can see damage on.
- **Every boundary crossing is a declared contract.** Anything leaving the process (topic, subject, RPC, HTTP,
  MQTT, queue, webhook) gets a `channel` block with its payload and delivery terms, `[external]` when the other
  side is outside this plan, and explicit fields on every `emit` and `call` so they can be checked.
- **Assume instead of asking.** Do not interrogate the user in chat. Make the best guess, and where the guess
  matters write a `??` on the exact line: `WHY` it matters, the `ASSUMED` default, and at least one `ALT` with
  its consequence. If WHY and a real alternative cannot be written, the question is not understood yet: read
  more code instead.
- **Scenarios prove the design.** Write the happy path and one scenario per failure path that matters, including
  the ugly ones: duplicate delivery, the other service down, a crash between two writes, two users at once.
  Give the state after each step. Start the state with `!` on the step where things go wrong. Be honest: a
  scenario that exposes a flaw in the plan is the most useful thing in it.
- **Branches are paths, so walk them.** Write conditions as `if`/`else`/`case`/`on ... failure` so the tool can
  see them. Each branch that carries risk (a different downstream system, a write, a failure path) deserves a
  scenario that takes it; the checker lists branches no scenario takes. Trivial guards such as "else return
  400" may stay unwalked: leave that warning standing rather than padding the plan with scenarios.
- **Reach for the optional parts only when the change needs them.** A lifecycle (orders, jobs, connections,
  screens) gets a `machine`. Timing that matters (leases, TTLs, timeouts, retries, timers) gets `[ttl]`,
  `[timeout]`, `after`/`every`, and a scenario with a clock. Most plans need neither. The plan exists to show
  flow and intent cheaply: if it is approaching the length of the code, it is too detailed.
- **Say what is left out** under `not doing:` so scope creep is visible before it exists.

## If a browser cannot be opened

Run `plan-review render <plan>` to write a standalone HTML copy, give the user the path, and ask them to paste
the review text it produces. Everything else in the workflow stays the same.

## Reference

- `references/format.md`: the full grammar and the list of checks.
- `examples/upload.plan`: one service; resources, a parallel block, a not-awaited call, decisions.
- `examples/order-flow.plan`: four services and four transports; contracts, handlers, emit and call, a fork.
- `examples/job-lease.plan`: a state machine, leases with TTLs, timers, a scenario with a clock, a decision log.
