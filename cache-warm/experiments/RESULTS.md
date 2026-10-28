# What was measured (2026-10-28, haiku, cloud session with OAuth through a gateway)

All numbers are `usage` fields from `claude -p --output-format json` (`cache_read_input_tokens`, `cache_creation_input_tokens`, and the `cache_creation.ephemeral_5m/1h_input_tokens` split) or from a probe mod's `$.model.fork` result. Prefix ≈ 45k tokens: a ~32k system-prompt layer shared by every directory, plus a ~13k per-directory conversation layer. Scripts: `ttl-refresh.sh`, `fork-ttl*.sh`, `probe-mod/`.

## Findings

1. **This auth writes the main conversation with the 1h TTL.** First probe: `ephemeral_1h_input_tokens: 15238, ephemeral_5m: 0`. Matches the documented subscription default.

2. **Cache entries are TTL-classed.** A 1h entry serves 5m and 1h requests; a 5m entry serves only 5m requests.
   - A 1h request over bytes written as 5m missed the conversation layer and rewrote it (upgrade R2: read 32,107 system layer, wrote 12,919 as 1h; two-step s2 fork: read 31,691, wrote 13,608).
   - A 5m request over bytes written as 1h hit them (s2 M2: read 90,473, wrote 0, seven minutes after the 1h fork wrote them).
   - Consequence: there is no cheap "upgrade" ping. A fork sent with a longer TTL than the main conversation rewrites the conversation at the 1h rate every time. `subagentPromptCacheTtl: "1h"` together with a 5m main conversation is the worst configuration for this mod, and the mod refuses to ping under it.

3. **A fork at the same TTL as the main conversation hits the whole prefix** when the main's last request ended in a tool result: two-step c2 fork read 45,291 / wrote 4. Its hit refreshed the 5m entries for five minutes (c2 M2 seven minutes later rewrote the conversation layer: 13,036 tokens).

4. **A fork after a turn with no tool call rewrites the last typed message.** Single-message probes: fork read 32,232 (system layer), wrote ~12,920 (the whole conversation layer, which there is one message). The history before the last typed message is replayed verbatim; per-request attachments on the last typed message differ. In a real session that delta is one message, not the whole conversation, and the mod counts it against the break-even.

5. **Changing `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` mid-process is destructive.** A fork sent right after `$.env.set(...)` read 0 and rewrote all 45,152 tokens, system layer included. Set at process start, the same variable behaved normally (finding 2 still applies). The mod never touches it.

6. **main → main hits in steady state.** Second run in a directory read 45,149 / wrote 0, so the probes' misses are not a first-run artifact.

7. **Pending (forward experiment, R2 at +56 min, R3 at +63 min):** whether a 5m fork's hit on a 1h entry refreshes it for an hour or for five minutes. Until it reads 1h, the mod plans on five minutes after the first ping, which is the safe assumption.

## What this means for the mod

- Pings are only safe when the fork's TTL ≤ the main conversation's TTL. Default configurations satisfy this everywhere (API key, Bedrock: 5m/5m; subscription: main 1h, fork 5m).
- On a 5m main conversation (API key, Bedrock, gateway), each ping buys five minutes: break-even is under an hour on 0.1× models, 1.6 h on Opus/Sonnet 5.5, 3.3 h on Fable 5.1. To make pings cheap, set **both** `promptCacheTtl` and `subagentPromptCacheTtl` to `"1h"`: then a ping buys an hour.
- On a subscription (main 1h, fork 5m), the first ping goes at 55 minutes. Whether the next one is due 4 or 55 minutes later depends on finding 7.
- The outcome of every ping is judged by what was read, and the write is charged to the break-even, so finding 4's delta is accounted for rather than treated as a failure.
