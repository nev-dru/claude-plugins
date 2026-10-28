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

Nothing to do: warming starts when a turn completes and stops when the next one starts. A two-line band above the prompt shows, live:

```
cache  warm · expires 52:10 · ping in 51:25 · stops 15:20 (break-even) · TTL 1h (subscription default) · 142k tok
       3 pings · spent $0.09 (0.4% of 5h) · saved $2.25 · net +$2.16  hide
```

The first line is the cache state (warm / cold / turn in progress) with a countdown to expiry and to the next ping, the TTL in effect and where it came from, and the prefix size. The second line is the session total: pings made, what they cost (dollars, plus five-hour-window points on a subscription), what warm returns saved, and the net. A saving is booked only when you come back after an idle period longer than the TTL **and** the first request is actually served from cache, so the number is realized, not projected. Hide the band with its button or `/cachewarm band`; turn it off for good with the `showBand` setting.

The TTL shown is what Claude Code will request, derived the way Claude Code derives it (`FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `promptCacheTtl`, `ENABLE_PROMPT_CACHING_1H`, then the auth-mode default: 1h on a subscription within plan usage, 5m everywhere else). The API's response doesn't tell a mod which TTL was written, so if you set the TTL somewhere unusual, set the `ttl` option to match.

`/cachewarm` subcommands:

- `status` (default): what it knows and what it plans
- `calc`: break-even table for the current model, TTL and prefix
- `off` / `on` / `auto`: switch modes for this session
- `manual <minutes>`: ping for a fixed duration
- `interval <minutes>`: ping interval (clamped below the TTL)
- `ping`: ping right now and report the usage (for validation)
- `stop`: stop warming this idle period
- `band`: hide or show the band above the prompt

Settings live in the plugin's config (`/plugin` → Installed → cache-warm, or `pluginConfigs` in settings.json): mode, interval, duration, `stopFraction`, TTL override, price overrides for Bedrock, `endAction` (`lapse` or `compact` while still warm), `blockIdleCompaction`, `verbose`.

## The mod sets the TTL for you

By default (`forceTtl: auto`) the mod sets `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` to `1h` at session start, before the first request, on a subscription, API key, Bedrock, Vertex or Foundry. Claude Code reads those per request, so the whole session runs in one TTL mode and every ping buys an hour: break-even 17–72 hours instead of under two. Through a gateway (`ANTHROPIC_BASE_URL`) it leaves your configuration alone, because the `ttl` field and the `anthropic-beta` header may not be forwarded; set `forceTtl: 1h` explicitly once you have confirmed they are.

What it costs: a 1h write is 2× base input instead of 1.25×, on each turn's *new* tokens only. One absence longer than five minutes per session pays that premium back (the avoided rewrite is 1.15–1.2× the whole prefix; the premium is 0.75× the tokens added). Set `forceTtl: off` to keep your own environment, or `5m` to pin the short cache.

Safety rules, each from a measurement in `experiments/RESULTS.md`: both buckets are always set together; nothing is changed in a conversation that already holds an assistant reply (a resumed session, a hot reload mid-session) because switching TTL mode over live entries costs one full rewrite; `FORCE_PROMPT_CACHING_5M` is respected; Bedrock models that only support 5m are never given 1h.

## Subscription, API key, Bedrock, LiteLLM: what differs

Claude Code picks the TTL per request, in two buckets: the **main conversation** and **everything else** (subagents, forks, compaction). Pings are forks, so they live in the second bucket.

| | Main conversation TTL | Forks (pings) TTL | Cache lives in | Cost unit |
| --- | --- | --- | --- | --- |
| Claude subscription, within plan usage | **1h** | 5m | Anthropic | five-hour / seven-day window % |
| Subscription over plan usage (usage credits) | 5m | 5m | Anthropic | dollars |
| API key | 5m | 5m | Anthropic (per workspace) | dollars |
| Amazon Bedrock | 5m | 5m | your AWS account's region | dollars, ~10 % above Anthropic list |
| Vertex / Foundry | 5m | 5m | the provider | dollars |
| LLM gateway (`ANTHROPIC_BASE_URL`, e.g. LiteLLM → Bedrock) | 5m | 5m | wherever it forwards | your upstream's rate |

How the mod handles each:

- **TTL detection** mirrors Claude Code's precedence: `FORCE_PROMPT_CACHING_5M` → `CLAUDE_CODE_PROMPT_CACHE_TTL` → `promptCacheTtl` → `ENABLE_PROMPT_CACHING_1H` → the bucket default above. On a subscription it drops to 5m when a usage window reaches 100 %, as Claude Code does. Whatever it detects, it then **learns from the API**: a hit after a 5-minute-plus gap with no pings proves 1h; a rewrite inside the hour proves 5m.
- **The ping must be in the same TTL mode as the main conversation** (measured, see `experiments/RESULTS.md`): 5m-mode and 1h-mode requests send different prefix bytes and never share cache entries, so a fork in the other mode rewrites the conversation on every ping instead of reading it. With nothing set for the subagent bucket a fork inherits the main conversation's TTL, which is the safe default everywhere. The mod reads the subagent-bucket controls (`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, `subagentPromptCacheTtl`) and refuses to ping when they differ from the main TTL. It never changes that variable itself: changed mid-process, the next fork missed everything.
- **What a ping buys** is therefore the main conversation's TTL: five minutes on a 5m conversation, an hour on a 1h one. `/cachewarm calc` prints the break-even for your pair.
- **Set both `promptCacheTtl` and `subagentPromptCacheTtl` to `"1h"`** on API key, Bedrock, Vertex, Foundry and gateways (Claude Code v2.1.242+). The 1h premium applies only to each turn's new tokens; one ping per 55 minutes then holds the whole conversation, and break-even moves from under an hour to 17–72 hours depending on the model. Setting only the main one leaves pings at 5m; setting only the subagent one is the configuration the mod refuses.
- **Bedrock**: every current Claude model supports the 1h TTL on Bedrock (5.x family, Opus 4.5–4.8, Sonnet 4.5+, Haiku 4.5); Claude 3.7/3.5 are 5m-only and the mod refuses a 1h assumption for them. Minimum cacheable prefix varies by model (512 to 4,096 tokens) and the mod won't warm below it. Bedrock's cross-region routing can write instead of read under load, so on Bedrock a first-ping rewrite only ends that idle period; it takes two idle periods in a row to pause the session. Dollar figures use Anthropic's multipliers at a 10 % higher base (third-party trackers, October 2026; verify on the AWS pricing page or set `inputPricePerMTok`). Break-even times don't change: they depend only on the multipliers.
- **LiteLLM / gateways**: the gateway must forward `cache_control` (with `ttl`) and the `anthropic-beta` header unchanged for the 1h TTL to reach Bedrock; LiteLLM can also set caching itself with `enable_anthropic_prompt_caching` / `anthropic_prompt_caching_ttl`. A gateway that strips the markers bills the whole conversation uncached on every turn: the mod sees two uncached requests in a row and stops warming until a request reads the cache. Set `inputPricePerMTok` to the upstream's rate so the dollar figures are right.
- **Subscription**: pings spend plan usage, not dollars. The band shows five-hour-window points spent on pings next to an API-equivalent dollar figure. Since the main conversation already has the 1h TTL, pings are rare (about one per 55 minutes).

## Guardrails

The one failure that matters is a ping that arrives after the cache expired: it doesn't read the prefix, it rewrites it at full price, and a loop of those would drain money fast. Everything below exists to make that impossible to repeat.

- **The TTL clock starts when the request starts.** The mod stamps the cache from the moment each request is sent, not from the end of its response: a three-minute generation on a five-minute cache leaves two minutes, and the mod knows it.
- **Latency-adaptive margin.** Every ping's round-trip is measured. The ping is sent `max(45s, 2.5× smoothed RTT, 1.5× slowest RTT) + 15s` before expiry, so a slow link pushes pings earlier. If the margin would exceed half the TTL, warming pauses with a suggestion to use the 1h TTL.
- **Missed-window check.** Before sending, the mod estimates when the ping will reach the API (now + half an RTT). If that's past expiry (the laptop slept, the timer ran late), it does not ping; it reports the miss and lets the cache lapse.
- **Every response is classified**: hit (read ≥ 80 % of the prefix, wrote < 5 %), partial, write (wrote ≥ 50 %, read < 20 %), or none. A ping that isn't a hit is a loss event, and the cause is worked out:
  - first ping of an idle period, sent well inside the TTL, and it wrote → the fork's request differs from the main thread (a gateway rewriting `cache_control`, a provider quirk). Warming **pauses for the session**; `/cachewarm on` resumes once you've fixed it.
  - sent near the edge and it wrote → expired in flight. The margin is raised to the observed latency and warming continues unless the link is now too slow for the TTL.
  - both counts zero → caching is off for this model or provider; pause.
  - two non-hits in one idle period → pause.
- **Per-idle-period cap.** Once pings in one idle period have cost what a cold rewrite would, warming stops regardless of the plan.
- **Session cap.** Two consecutive idle periods that spent on pings without a warm return pause automatic warming (you keep leaving for longer than the break-even point; lower `stopFraction` or use the 1h TTL).
- **Main-thread health.** If your own last two requests rewrote a prefix that should have been warm, caching isn't working on this provider and the mod doesn't warm until a real turn reads the cache again.
- **API errors**: rate-limit, overload and 5xx answers retry with backoff, but only while the retry can still land inside the window; anything else stops.
- **No concurrent pings**, any real turn cancels warming, idle compaction is skipped while warming, and `/cachewarm ping` refuses to ping a cache it believes is cold unless you add `force`.
- **The TTL is learned, not only configured.** A hit after a gap longer than five minutes with no pings can only come from a one-hour entry, and a rewrite inside the hour after a five-minute-plus gap means five minutes; the band's TTL source changes to `observed` when that happens.
- The session must stay open: a mod only runs inside a live Claude Code process.

See `VALIDATE.md` for the experiments that confirm the assumptions on your provider before trusting the numbers.

## License

MIT
