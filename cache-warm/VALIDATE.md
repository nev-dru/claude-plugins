# Validate before trusting the numbers

The cost model rests on a few assumptions that should be confirmed once per provider. Each experiment uses `/cachewarm ping` (set `verbose: true` first) and reads the usage it logs: `read` (cache_read_input_tokens), `wrote` (cache_creation_input_tokens), `uncached` (input_tokens), `out` (output_tokens).

1. **A ping hits the cache.** Right after a turn, run `/cachewarm ping`. Expect `read ≈ prefix`, `wrote` small, `uncached` tiny. If `read` is near zero the fork's request differs from the main thread's (gateway rewriting `cache_control`, an unsupported model). Fix that before enabling warming.

2. **A ping refreshes the TTL.** On a 5m cache: turn, wait 4 min, ping, wait 4 min, send a real turn. The real turn's `/usage` line (or a status line reading `current_usage`) should show cache reads, not a big write. Repeat on a 1h cache with 50-minute gaps if you run one.

3. **A ping on a 1h-TTL session keeps the 1h TTL.** Forks fall in Claude Code's "everything else" TTL bucket (5m by default). Measured so far (`experiments/RESULTS.md`): a 5m request hits a 1h entry; whether that hit refreshes it for an hour or five minutes is the forward experiment (`experiments/ttl-refresh.sh forward`). Do **not** "fix" this with `subagentPromptCacheTtl: "1h"` on a 5m conversation: a fork with a longer TTL than the main rewrites the conversation every time. Set both TTLs to 1h or leave both alone.

4. **What a ping really costs.** Read `out` on a few pings. With extended thinking the model may think before answering; output tokens bill at ~5× base input. The mod re-plans the break-even with the measured average, so this only matters for how close the estimate in `/cachewarm calc` is.

5. **Bedrock.** Confirm the model row in the Bedrock prompt-caching docs supports caching (and 1h TTL if you use it), then compare the per-token rates on the Bedrock pricing page with the mod's table; override `inputPricePerMTok` and `cacheReadMultiplier` if they differ. With cross-region inference, Bedrock may occasionally write instead of read under load; the mod counts that as a miss.

6. **LiteLLM → Bedrock.** Check the gateway forwards `cache_control` (with `ttl` when you use 1h) and the `anthropic-beta` header. LiteLLM issue #17250 tracked `ttl` being rejected on Bedrock before Bedrock added the 1h option; verify with your LiteLLM version. `enable_anthropic_prompt_caching` / `anthropic_prompt_caching_ttl` in `litellm_settings` can also set caching gateway-side.

7. **Subscription.** The mod reports ping cost as the change in the five-hour usage window. Check a few pings' deltas against a cold rebuild's delta to see how your plan weights cache reads vs writes.

8. **Idle compaction (v2.1.290+).** On a 1h TTL in a terminal session, Claude Code can compact an idle conversation shortly before the cache expires. With `blockIdleCompaction: true` the mod skips that while warming; confirm you see the skip notice rather than a compaction.

Answered: a fork sent with a 1h TTL on a 5m session does **not** upgrade the entry for the price of the appended tokens. It rewrites the conversation at 2× (measured; `experiments/RESULTS.md`, finding 2).
