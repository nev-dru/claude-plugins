# Plan format

Plain text. Indentation is significant (spaces; tabs count as four). Top-level constructs start at column 0.

```
# Title
intent: one or two sentences on what this change is for

[+|~] type Name                       a data shape
    field: type  // comment           a trailing ? on the field name marks it optional
    unique (a, b)                      any other line is a free-form rule
[+|~] type Name = alias

[+|~] channel kind:name  [external]   a contract between systems; kind is free (kafka, nats, grpc, http, emqx, sqs ...)
    payload: TypeName                  or request: / response: for request and reply
    delivery: at-least-once, ordered per key
    timeout: 2s                        any other "key: value" is a term of the contract
    owner: / consumer: / retries: / loss: acceptable because ...

group name                             files below belong to this group until the next group line; the diagram
                                       draws one lane per group, so use it for areas of responsibility
service name                           the same thing, for when the boundary is a deployable

[+|~] file path/to/file.ext
  [+|~] fn name(args) -> ReturnType  [on kind:name] [tags]  // comment
      body line, one idea per line, nested by indentation
      x = -> file.fn(args)             call another planned function; "file" is the basename without extension,
                                       and may be dropped for a function in the same file
      emit kind:name { field, field }  send a message and move on
      call kind:name { field, field }  send a request and wait for the reply
      parallel:                        the children of this line run at the same time
      for each ...: / while ...:       a loop
      on <something> failure:          a handler block (also: catch, rescue, except)
      ?? WHY what this decides | ASSUMED the default | ALT an alternative: its consequence

trace Scenario name
  fnName > fragment | state after this step
  fnName > fragment | ! state, on a step where something goes wrong

not doing:
  - item
```

## Review mode: describing code that already exists

```
diff: main...HEAD                      the git range under review (anything `git diff` accepts; `HEAD` = uncommitted work)
ignore: package-lock.json, dist/, **/*.snap     changed files the review deliberately leaves out

~ file src/storage.ts
  ~ fn saveFile(file, user) -> FileRecord @ 7-18        where the function lives: new-side line numbers
      insert the row @ 13 [db:files]                     where this step lives (optional, inside the function's range)
  + region MAX_BYTES, a 25 MB cap @ 4                     changed code that is not a function: imports, constants, config
  fn getFile(id) -> FileRecord @ 24-26 // unchanged
  fn helper() @ src/other.ts:40-52                        an anchor may name another file
- file src/legacy.ts                                     a file the change deletes
```

With a `diff:` line, `check` and the review page read the real diff and add these checks:

Errors
- a changed, non-blank line that no anchor covers and no `ignore:` entry excuses
- a function marked unchanged whose range contains changed lines
- an anchor that points outside the file, or at a file that does not exist in the reviewed revision
- a deleted file the plan does not list with `- file`

Warnings
- a function marked `~` with no changed lines in its range, or `+` when most of its range already existed
- a changed function with no anchor
- a line anchor outside its function's range

## State machines (optional: use when something has a lifecycle)

```
[+|~] machine Job
    states: queued, running, done, failed
    initial: queued
    final: done, failed
    queued -> running  on a worker claims it
    running -> queued  on the lease lapses  after 30s
    running -> failed  on the lease lapses  if attempts reached 3
    * -> failed  on an operator cancels it  [external]
```

A transition is `from -> to`, then any of `on <event>`, `if <guard>`, `after <duration>`. `*` means from any state.
`[external]` means something outside the plan performs it. In a function body, `transition Job to running`
(also `move` / `set ... to`) is the line that performs it; that ties the code to the machine.

Checked: states used but not declared, states nothing leads to, dead ends that are not final, one event leading
two ways with no guard, code moving to a state with no transition into it, transitions nothing performs, and
transitions no scenario takes. The page draws the machine and, while a scenario is walked, shows the current state.

## Time (optional: use when timing is part of the design)

```
write the lease  [db:jobs] [ttl:30s]        this write is only good for 30s
call the carrier  [network:carrier] [timeout:5s]
after 30s:                                  a timer branch: children run when it fires
every 10s:                                  a periodic branch
```

Channels already take `timeout:` and `retries:`. Durations: `250ms`, `30s`, `5m`, `2h`, `1d`.

Scenario steps can move the clock: start the state with `+45s:` (after a `!` if there is one).

```
runJob > do the work | +45s: the worker sat in a long pause, so no heartbeat ran
finish > transition Job to done | ! +4s: the worker wakes up and finishes a job it no longer owns
```

A scenario with a clock gets a timeline: steps placed in time, and a bar for every `[ttl]` write showing when it
runs out. Checked: a handler that must answer a channel within its `timeout:` but can wait longer than that on
something else; a channel with `retries:` feeding a handler that is not safe to repeat. `after` and `every`
blocks count as branches, so the checker wants a scenario that lets them fire.

## Decision log

```
decided:
  - 2026-09-12 | run.claimNext | what the choice decides | chose: the option taken | over: a rejected option; another
```

The review server appends an entry for every decision the reviewer sends. Never edit or remove entries: when
you apply a decision, delete its `??` line and change the pseudocode, and leave `decided:` alone. The page shows
the log as a timeline, so later readers can see what was chosen, what was turned down, and why it mattered.

`[entry]` on a function signature marks an entry point (a CLI command, a cron job, a worker loop) so it is not
reported as "nothing calls it".

## Branches

Write conditions the way you would say them. These forms are recognized as branches:

```
if <condition>:                 a block; its children run only on that condition
else if <condition>: / elif ...:
else: / otherwise:
case <value>:                   arms of a multi-way choice (put them under a plain "match x:" line)
on <something> failure:         a failure branch (also catch / rescue / except)
if <condition>: return 413      one line: condition, then what happens
return early if <condition>     one line: what happens, then the condition (return, throw, skip, continue ...)
validate the input, else return 400
```

What the tool derives from them:
- A call, message or resource touched inside a branch becomes a conditional edge in the diagram, drawn with a
  small diamond and labelled with its condition. An `else` is labelled "not <the if condition>".
- For every scenario it works out which branches were taken and which were passed over. While that scenario is
  being walked, passed-over branches and their edges are dimmed, so the path this scenario takes stands out.
- Every branch line carries a marker: filled when some scenario takes it, hollow when none does.
  `check` warns about changed functions no scenario enters, and about branches no scenario takes.

Markers: `+` new, `~` modified, `-` removed (files only), none unchanged. They apply to types, channels, files and functions.

Tags go at the end of a line or a signature: `[db:name]` `[network:name]` `[throws]` `[mutates]`
`[async]` (started but not awaited). `[on kind:name]` on a signature makes that function the handler of a channel.

Scenario steps: `fragment` is text that appears in exactly one line of that function (case-insensitive). Use
`file.fnName` when two functions share a name. The state is free text; show what is in the database, on the
wire, or returned.

## What `plan-review check` verifies

Errors
- a call `-> x.y(` to a function the plan does not define
- a channel that is used but has no `channel` block
- an `emit`/`call` that sends a field its payload type does not have
- a scenario step that matches no line
- a line the parser cannot place

Warnings
- a callee can throw and the caller neither handles it nor marks the call `[throws]`
- an `[async]` call to something that throws: the error is lost
- `[db]` or `[network]` work inside a loop
- parallel branches that touch the same named resource
- a new function nothing calls (handlers with `[on ...]` are exempt)
- an `emit`/`call` that omits a required payload field
- a function that writes to a database and emits, with no outbox or transaction
- an at-least-once channel feeding a handler with side effects and nothing idempotent
- an at-most-once channel whose contract does not address loss
- a `call` with a timeout, or to a handler that throws, where the caller does not say what happens on failure
- a channel with senders but no handler, or the reverse, that is not `[external]`
- a changed channel or payload type whose other side is external
- in review mode, four or more files and no `group` or `service` lines

The checks read tags and a few keywords (at-least-once, at-most-once, outbox, transaction, idempotent, dedupe,
upsert, "exists for"). They catch omissions, not wrong logic. Scenarios and the reviewer catch the rest.
