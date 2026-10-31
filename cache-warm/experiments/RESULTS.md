# What was measured (2026-10-28, haiku, cloud session with OAuth through a gateway)

All numbers are `usage` fields from `claude -p --output-format json` (`cache_read_input_tokens`, `cache_creation_input_tokens`, and the `cache_creation.ephemeral_5m/1h_input_tokens` split) or from a probe mod's `$.model.fork` result. Prefix ≈ 45k tokens: a ~32k system-prompt layer shared by every directory, plus a ~13k per-directory conversation layer. Scripts: `ttl-refresh.sh`, `fork-ttl*.sh`, `probe-mod/`.

## Findings

1. **This auth writes the main conversation with the 1h TTL.** First probe: `ephemeral_1h_input_tokens: 15238, ephemeral_5m: 0`. Matches the documented subscription default.

2. **5m-TTL and 1h-TTL requests never share cache entries.** Every 5m request read a 32,232-token system layer and every 1h request a 32,107-token one: the two TTL modes send prefixes that differ by ~125 tokens (the 1h beta header changes the rendering), so a request in one mode cannot hit an entry written in the other, in either direction.
   - 1h request over bytes written as 5m: missed the conversation layer and rewrote it (upgrade R2: wrote 12,919 as 1h; two-step s2 fork: read 31,691, wrote 13,608).
   - 5m request over bytes written as 1h: missed too (forward R2 at +56 min: wrote 12,919 as 5m), and so the 1h entry was not kept alive (forward R3 at +63 min rewrote it).
   - The one apparent counter-example (s2 M2 reading 90k seven minutes after a 5m refresh) is lazy eviction: c2 M2, the same setup two seconds apart, was evicted at 7m02s. Entries live *at least* their TTL, not exactly.
   - Consequence: there is no cheap "upgrade" ping, and a fork in the other TTL mode from the main conversation rewrites the conversation every time.

2b. **A fork inherits the main conversation's TTL unless the subagent bucket is set explicitly.** Two-step shape: main 1h + subagent unset → fork read 45,166 / wrote 4; main 1h + subagent 1h → the same; main 5m + subagent unset → read 45,291 / wrote 4; main 5m + subagent 1h → read 31,691 / wrote 13,608. So the default configurations are safe everywhere, and an explicit `subagentPromptCacheTtl` that differs from `promptCacheTtl` is the configuration the mod refuses.

3. **A fork at the same TTL as the main conversation hits the whole prefix** when the main's last request ended in a tool result: two-step c2 fork read 45,291 / wrote 4. Its hit refreshed the 5m entries for five minutes (c2 M2 seven minutes later rewrote the conversation layer: 13,036 tokens).

4. **A fork after a turn with no tool call rewrites the last typed message.** Single-message probes: fork read 32,232 (system layer), wrote ~12,920 (the whole conversation layer, which there is one message). The history before the last typed message is replayed verbatim; per-request attachments on the last typed message differ. In a real session that delta is one message, not the whole conversation, and the mod counts it against the break-even.

5. **Changing `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` mid-process is destructive.** A fork sent right after `$.env.set(...)` read 0 and rewrote all 45,152 tokens, system layer included. Set at process start, the same variable behaved normally (finding 2 still applies). The mod only sets it together with the main variable, at session start, before any request (finding 8); never mid-process.

6. **main → main hits in steady state.** Second run in a directory read 45,149 / wrote 0, so the probes' misses are not a first-run artifact.

7. **A default fork on a 1h conversation keeps it alive for a full hour.** Long-lived headless session (`longlive.sh`, stdin held open): turn 1 wrote 45,166 as 1h at T0; the probe mod forked at T0+56 min (read 45,166, wrote 4); turn 2 at T0+63 min read 90,401 and wrote 184 (its own new tokens). The entry's own lifetime ended at T0+60 min, so the fork's refresh carried it. One 55-minute ping per hour is enough on a subscription.

8. **A mod can set the TTL itself.** `$.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', ...)` and the subagent variable, called in `session.start`, governed the very first request: on this 1h-default auth the probe asked for 5m and the main conversation wrote `ephemeral_5m: 13,596, 1h: 0`; the fork then hit the full prefix (45,287 read, 4 written). The shipped mod's `forceTtl` path was verified the same way (`wrote 5m 12,919, 1h 0`). Claude Code reads the variable per request, so a value set before the first request is consistent for the whole session; finding 5 is what happens when it changes after entries exist.

## What this means for the mod

- The mod sets the TTL itself by default (`forceTtl: auto` → 1h on an API key, Bedrock, Vertex and Foundry; a subscription, already 1h, and a gateway are left alone) so warming does not depend on the user's environment. A conversation that already has an assistant reply is left alone, unless the mod ran it before: then it gets the TTL on record for it, so it goes on in the mode its entries were written in.
- Pings are safe only when the fork is in the same TTL mode as the main conversation. With the subagent bucket unset the fork inherits it, so the defaults are safe everywhere: API key and Bedrock 5m/5m, subscription 1h/1h.
- On a 5m main conversation (API key, Bedrock, gateway), each ping buys five minutes: break-even is under an hour on 0.1× models, 1.6 h on Opus/Sonnet 5.5, 3.3 h on Fable 5.1. Set `promptCacheTtl: "1h"` (and, to be explicit, `subagentPromptCacheTtl: "1h"` too — never only the subagent one) and a ping buys an hour.
- On a subscription (main 1h, fork inherits 1h) pings go out every 55 minutes: break-even 17–72 hours depending on the model.
- The outcome of every ping is judged by what was read, and the write is charged to the break-even, so finding 4's delta is accounted for rather than treated as a failure.
- Finding 2's lazy eviction (a 5m entry still read seven minutes on) is why the mod's observed-TTL check takes a hit as proof of 1h only after a gap of ten minutes or more.

## Not measured yet

What the mod assumes, and how each could be measured with a probe mod like `probe-mod/`:

- **Over-plan vs. the env variable.** Whether Claude Code's drop to 5m past a subscription's plan usage overrides a `CLAUDE_CODE_PROMPT_CACHE_TTL` set in the environment. The mod leaves a subscription's TTL alone, so this matters only with `forceTtl: 1h` there. Measure: force 1h, cross 100 % of the five-hour window, read `ephemeral_5m/1h_input_tokens` on the next turn.
- **Gateway variables for Vertex and Foundry.** The mod reads `ANTHROPIC_VERTEX_BASE_URL` and `ANTHROPIC_FOUNDRY_BASE_URL` as the base-URL overrides, and their own hosts as `aiplatform.googleapis.com` (global or regional, `us-east5-aiplatform.googleapis.com`) and `*.services.ai.azure.com`, `*.openai.azure.com` or `*.cognitiveservices.azure.com`. Check against Claude Code's provider docs.
- **Session id across a resume.** The per-conversation TTL record is keyed by `$.session.id()`, assumed to stay the same under `--resume` and `--continue`. If it changes, a resumed conversation has no record and is left alone (the safe direction). Measure: log the id at `session.start` before and after a `--resume`.
- **What `$.session.turns()` counts at `session.start`.** Assumed 0 for a new session, including one started with a prompt on the command line (`claude "..."`, `-p`); above 0, the transcript is read for an answer before anything is left alone. Measure: log both in a probe's `session.start`.
- **Setting the TTL later.** Whether a value set in the first `turn.start` (rather than `session.start`) still governs that turn's first request. If it does, the mod could decide with the transcript loaded. Measure as finding 8, with the `$.env.set` moved.
- **Which trigger Claude Code's idle compaction uses** (`auto` or `precompute`). The mod skips both while warming under 75 % of the auto-compact threshold.
- **Bedrock 1h support for Sonnet 4 and Opus 4.0/4.1.** Only the Claude 3 models are held to 5m. Check the Bedrock prompt-caching docs.

