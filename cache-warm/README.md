# cache-warm

A Claude Code mod that keeps your session's prompt cache warm while you step away, and stops at the break-even point so it can only ever save tokens.

## What it does

Every turn in Claude Code re-sends the whole conversation. While the prompt cache is warm that prefix bills at the cache-read rate (0.1× base input, 0.05× on Opus/Sonnet 5.5, 0.025× on Fable/Mythos 5.1). Let it lapse and the first turn back rewrites it at 1.25× (5-minute TTL) or 2× (1-hour TTL).

When a turn completes and the session goes idle, `cache-warm` pings the cache just before it would expire. A ping is `$.model.fork`: Claude Code re-sends the session's own prefix plus a one-character request through its normal auth path (subscription, API key, Bedrock, Vertex, Foundry, or an LLM gateway such as LiteLLM). The prefix is served from cache, which refreshes its TTL, and the fork's tail is never cached, so a ping costs read(prefix) + a few output tokens.

In **auto** mode it keeps pinging only while the cumulative ping cost is below what one cold rewrite would cost (times `stopFraction`), then stops and lets the cache lapse. Worst case you spent one rewrite for nothing; best case you saved one. In **manual** mode it pings for `durationMinutes`.

The break-even point does **not** depend on how big the session is: the saving and each ping both scale with the prefix. Only the TTL, the model's read multiplier and the interval set it:

| Model | 5m TTL, ping every 4 min | 1h TTL, ping every 55 min |
| --- | --- | --- |
| Fable 5.1 / Mythos 5.1 | 49 pings ≈ 3.3 h | 79 pings ≈ 72 h |
| Opus 5.5 / Sonnet 5.5 | 24 pings ≈ 1.6 h | 39 pings ≈ 36 h |
| Opus 4.x–5, Sonnet 4.x–5, Haiku | 11.5 pings ≈ 46 min | 19 pings ≈ 17 h |

So on a 5-minute cache, pinging for two hours usually loses; a 1-hour TTL plus one ping per 55 minutes wins by a wide margin. `/cachewarm calc` prints this for your model and prefix size.

## Install

At the prompt of a terminal session (answer `y` to add the marketplace, then pick a scope):

```
/plugin install cache-warm --marketplace nev-dru/claude-plugins
```

From the shell: `claude plugin install cache-warm --marketplace nev-dru/claude-plugins`. For one session only: `claude --plugin-dir ./cache-warm`. Needs Claude Code v2.1.287 or later (mods). After installing from the shell, run `/reload-plugins` in an open session.

## Use

Nothing to do: warming starts when a turn completes and stops when the next one starts. A status line under the prompt shows the TTL, next ping, pings so far and their cost, and when it will stop.

`/cachewarm` subcommands:

- `status` (default): what it knows and what it plans
- `calc`: break-even table for the current model, TTL and prefix
- `off` / `on` / `auto`: switch modes for this session
- `manual <minutes>`: ping for a fixed duration
- `interval <minutes>`: ping interval (clamped below the TTL)
- `ping`: ping right now and report the usage (for validation)
- `stop`: stop warming this idle period

Settings live in the plugin's config (`/plugin` → Installed → cache-warm, or `pluginConfigs` in settings.json): mode, interval, duration, `stopFraction`, TTL override, price overrides for Bedrock, `endAction` (`lapse` or `compact` while still warm), `blockIdleCompaction`, `verbose`.

## Get the most out of it

- **API key, Bedrock, Vertex, Foundry, LiteLLM**: set `"promptCacheTtl": "1h"` in settings (v2.1.242+). The 1h write premium applies only to each turn's new tokens, and then one ping per 55 minutes keeps the whole conversation warm.
- **Claude subscription**: the main conversation already gets the 1h TTL within plan usage, so pings are rare and cheap. Costs are tracked as the change in your five-hour usage window instead of dollars.
- **Bedrock**: 1h TTL availability varies by model; check the model row in the Bedrock prompt-caching docs. Bedrock cache rates may differ from Anthropic's table: set `inputPricePerMTok` / `cacheReadMultiplier`.
- **LiteLLM / gateways**: the gateway must forward `cache_control` markers and the `anthropic-beta` header unchanged. If the first ping reports a miss, the gateway is rewriting the request.

## Safety rails

- The first ping after a turn must hit the cache; if it misses, warming stops (a miss means pings would each cost a full rewrite).
- Two misses or three API errors in one idle period stop warming.
- Any real turn cancels warming immediately; the turn itself refreshes the cache.
- While warming, Claude Code's own idle compaction is skipped (configurable), so history isn't discarded for nothing.
- The session must stay open: a mod only runs inside a live Claude Code process. Closing the terminal ends warming.

See `VALIDATE.md` for the experiments that confirm the assumptions on your provider before trusting the numbers.

## License

MIT
