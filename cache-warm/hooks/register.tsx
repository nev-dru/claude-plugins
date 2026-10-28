// cache-warm: keeps the main conversation's prompt cache warm while the
// session is idle, by forking the session's own prefix at an interval, and
// stops at the break-even point so it never spends more than one cold rewrite.
//
// How a ping works: $.model.fork re-sends the main thread's last request
// (same model, system prompt, tools, messages) plus one tiny user message,
// through Claude Code's own auth path (subscription, API key, Bedrock, Vertex,
// Foundry, or an LLM gateway). The prefix is served from the prompt cache,
// which refreshes the entry's TTL at the cache-read rate. The fork's own tail
// is never cached, so a ping costs read(prefix) + a few output tokens.
import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, ModelUsage, SessionUsage } from 'claude-code'

import type { CacheView, Phase, Ttl } from '../types'

type Mode = 'auto' | 'manual' | 'off'
type Provider = 'subscription' | 'api-key' | 'bedrock' | 'vertex' | 'foundry' | 'gateway'

type Options = {
  mode: Mode
  intervalMinutes: number
  durationMinutes: number
  stopFraction: number
  ttl: 'detect' | Ttl
  inputPricePerMTok: number
  cacheReadMultiplier: number
  endAction: 'lapse' | 'compact'
  blockIdleCompaction: boolean
  matchPingTtl: boolean
  showBand: boolean
  verbose: boolean
}

// Base input price in USD per MTok, the cache-read multiplier vs base, and the
// minimum cacheable prefix in tokens, from the Claude pricing/caching docs.
// Output is ~5x base input across the lineup. Order matters: first match wins.
// Bedrock keeps the same multipliers at a ~10% higher base (third-party price
// trackers, Oct 2026; verify on the AWS pricing page): BEDROCK_MARKUP below.
// A gateway's upstream rates are unknown here: set inputPricePerMTok.
const PRICES: { re: RegExp; input: number; read: number; min: number; longInput?: number }[] = [
  { re: /fable-5-1|mythos-5-1/, input: 10, read: 0.025, min: 512 },
  { re: /fable-5|mythos-5/, input: 10, read: 0.1, min: 512 },
  { re: /opus-5-5/, input: 4, read: 0.05, min: 512 },
  { re: /sonnet-5-5/, input: 2, read: 0.05, min: 512 },
  { re: /haiku-5-5/, input: 0.1, read: 0.1, min: 512, longInput: 0.5 },
  { re: /opus-5/, input: 5, read: 0.1, min: 512 },
  { re: /opus-4-8/, input: 5, read: 0.1, min: 1024 },
  { re: /opus-4-[5-7]/, input: 5, read: 0.1, min: 4096 },
  { re: /opus-4/, input: 15, read: 0.1, min: 1024 },
  { re: /sonnet-5/, input: 2, read: 0.1, min: 1024 },
  { re: /sonnet-4/, input: 3, read: 0.1, min: 1024 },
  { re: /3-7-sonnet|3-5-sonnet/, input: 3, read: 0.1, min: 1024 },
  { re: /haiku-4-5/, input: 1, read: 0.1, min: 4096 },
  { re: /haiku-3-5/, input: 0.8, read: 0.1, min: 2048 },
]
const BEDROCK_MARKUP = 1.1
// Models whose Bedrock integration supports the 5-minute TTL only.
const BEDROCK_5M_ONLY = /3-7-sonnet|3-5-sonnet/
const OUTPUT_RATIO = 5
const WRITE_MULT: Record<Ttl, number> = { '5m': 1.25, '1h': 2 }
const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const SAFETY_MS = 45_000 // the lifetime runs from the request's start; pings take time
const PING_PROMPT =
  'Cache keep-alive ping. Reply with exactly one character: "." Do not call any tool. Do not explain.'

type Pricing = { input: number; read: number; output: number; known: boolean }

// ---- pure math ---------------------------------------------------------------

export function pricing(model: string, prefix: number, o: Options, provider = ''): Pricing {
  const row = PRICES.find((p) => p.re.test(model))
  let input = row ? (row.longInput && prefix > 100_000 ? row.longInput : row.input) : 3
  if (provider === 'bedrock') input *= BEDROCK_MARKUP
  let read = row ? row.read : 0.1
  if (o.inputPricePerMTok > 0) input = o.inputPricePerMTok
  if (o.cacheReadMultiplier > 0) read = o.cacheReadMultiplier
  return { input, read, output: input * OUTPUT_RATIO, known: !!row }
}

export function minCacheable(model: string): number {
  return PRICES.find((p) => p.re.test(model))?.min ?? 1024
}

export function usd(u: ModelUsage, p: Pricing, ttl: Ttl): number {
  return (
    (u.input_tokens * p.input +
      u.cache_creation_input_tokens * p.input * WRITE_MULT[ttl] +
      u.cache_read_input_tokens * p.input * p.read +
      u.output_tokens * p.output) /
    1e6
  )
}

// The economics, in USD, for a prefix of `prefix` tokens.
//   saving  = what a warm return saves vs a cold one: prefix * (write - read)
//   ping    = what one ping costs: prefix * read + ~20 output tokens (or the measured average)
//   pings   = break-even number of pings = saving / ping. Independent of prefix size
//             for large prefixes; only the output-token overhead depends on it.
export function economics(prefix: number, ttl: Ttl, p: Pricing, measuredPing?: number) {
  const w = WRITE_MULT[ttl]
  const saving = (prefix * p.input * (w - p.read)) / 1e6
  const ping = measuredPing ?? (prefix * p.input * p.read + 20 * p.output) / 1e6
  const pings = ping > 0 ? saving / ping : 0
  return { saving, ping, pings }
}

export function defaultIntervalMs(ttl: Ttl): number {
  return ttl === '1h' ? 55 * 60_000 : 4 * 60_000
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (Math.abs(n) < 0.01) return (n < 0 ? '-' : '') + '<$0.01'
  return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2)
}
function fmtMin(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`
}
function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

// ---- state (module-level: the hooks share it; a reload starts it over) ---------

const view = atom({ plugin: 'cache-warm', key: 'view' } as const, null)
const hidden = atom({ plugin: 'cache-warm', key: 'hidden' } as const, false)

const S = {
  o: {
    mode: 'auto',
    intervalMinutes: 0,
    durationMinutes: 120,
    stopFraction: 1,
    ttl: 'detect',
    inputPricePerMTok: 0,
    cacheReadMultiplier: 0,
    endAction: 'lapse',
    blockIdleCompaction: true,
    matchPingTtl: true,
    showBand: true,
    verbose: false,
  } as Options,
  // session facts
  provider: 'subscription' as Provider,
  ttl: '5m' as Ttl,
  ttlSource: 'default',
  model: '',
  prefixTokens: 0, // size of the cached prefix the next cold turn would rewrite
  lastRequestAt: 0, // start of the last main-thread request or ping (the TTL runs from there)
  turnRunning: false,
  // warming state
  warming: false,
  idleStartAt: 0,
  stopAt: 0,
  nextPingAt: 0,
  timer: undefined as { cancel: () => void } | undefined,
  ticker: undefined as { cancel: () => void } | undefined,
  idlePings: 0,
  idleMisses: 0,
  idleSpent: 0,
  idleSpentPct: 0,
  lastPingUsd: undefined as number | undefined,
  avgPingUsd: undefined as number | undefined,
  idleRealized: false, // this idle period ended in a warm return
  // a return to check: did pings keep the cache warm through an idle period
  // longer than the TTL? Resolved by the first request of the next turn.
  pendingReturn: undefined as { prefix: number; saving: number } | undefined,
  // guardrails
  pinging: false, // a fork is in flight
  rttMax: 0, // slowest ping round-trip this session, ms
  rttEma: 0, // smoothed ping round-trip, ms
  retryBackoffMs: 0, // after a 429/overloaded answer
  paused: '', // why automatic warming is off until /cachewarm on
  consecutiveLosses: 0, // idle periods that spent on pings and never came back warm
  firstPingWrites: 0, // idle periods whose first ping rewrote a live cache (Bedrock tolerates one)
  subagentTtlEnv: undefined as string | undefined, // CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL as the user set it
  force5m: false,
  mainWrites: 0, // consecutive main-thread requests that rewrote a prefix that should have been warm
  gapPings: 0, // pings made since the last real request, judged by the next one
  // session totals
  pings: 0,
  spent: 0,
  saved: 0,
  spentPct: 0,
  returnsWarm: 0,
  returnsCold: 0,
  misses: 0,
  writes: 0,
  // /cachewarm overrides for this session
  overrideMode: undefined as Mode | undefined,
  overrideInterval: undefined as number | undefined,
  overrideDuration: undefined as number | undefined,
}

function mode(): Mode {
  return S.overrideMode ?? S.o.mode
}

// How long before the cache's expiry a ping is sent. The TTL runs from the
// moment the API starts reading the request, and on a slow connection a
// multi-megabyte prefix takes a while to upload, so the margin grows with the
// round-trips we have observed: a ping that arrives after expiry doesn't read
// the cache, it rewrites it, which is the one outcome this mod exists to avoid.
function marginMs(): number {
  const fromLatency = Math.max(2.5 * S.rttEma, 1.5 * S.rttMax) + 15_000
  return Math.max(SAFETY_MS, Math.ceil(fromLatency))
}

// True when the connection is too slow for this TTL: a ping would need to be
// sent so early that it hardly extends anything.
function tooSlowForTtl(): boolean {
  return marginMs() > TTL_MS[S.ttl] / 2
}

function intervalMs(): number {
  const want =
    S.overrideInterval ?? (S.o.intervalMinutes > 0 ? S.o.intervalMinutes * 60_000 : defaultIntervalMs(S.ttl))
  return Math.max(30_000, Math.min(want, TTL_MS[S.ttl] - marginMs()))
}

function priceNow(): Pricing {
  return pricing(S.model, S.prefixTokens, S.o, S.provider)
}

// What a response's usage says the API did with the prefix.
type CacheOutcome = 'hit' | 'partial' | 'write' | 'none'
function classify(u: ModelUsage, prefix: number): CacheOutcome {
  if (prefix <= 0) return 'none'
  const read = u.cache_read_input_tokens / prefix
  const wrote = u.cache_creation_input_tokens / prefix
  if (read >= 0.8 && wrote < 0.05) return 'hit'
  if (wrote >= 0.5 && read < 0.2) return 'write'
  if (read > 0.05 || wrote > 0.05) return 'partial'
  return 'none'
}

function noteRtt(ms: number): void {
  S.rttMax = Math.max(S.rttMax, ms)
  S.rttEma = S.rttEma ? 0.7 * S.rttEma + 0.3 * ms : ms
}

function planStopAt(from: number): number {
  if (mode() === 'manual') return from + (S.overrideDuration ?? S.o.durationMinutes) * 60_000
  const e = economics(S.prefixTokens, S.ttl, priceNow(), S.avgPingUsd)
  return from + Math.max(0, S.o.stopFraction) * e.pings * intervalMs()
}

function phase(now: number): Phase {
  if (S.turnRunning) return 'turn'
  if (S.warming) return 'warming'
  if (!S.lastRequestAt) return 'none'
  if (now - S.lastRequestAt < TTL_MS[S.ttl]) return 'warm'
  return S.paused ? 'paused' : 'cold'
}

function snapshot(now: number): CacheView {
  return {
    now,
    phase: phase(now),
    ttl: S.ttl,
    ttlSource: S.ttlSource,
    provider: S.provider,
    model: S.model,
    prefixTokens: S.prefixTokens,
    lastRequestAt: S.lastRequestAt,
    nextPingAt: S.nextPingAt,
    stopAt: S.stopAt,
    mode: mode(),
    marginMs: marginMs(),
    rttMs: S.rttMax,
    paused: S.paused,
    idlePings: S.idlePings,
    idleSpent: S.idleSpent,
    pings: S.pings,
    spent: S.spent,
    saved: S.saved,
    spentPct: S.spentPct,
    returnsWarm: S.returnsWarm,
    returnsCold: S.returnsCold,
    misses: S.misses,
    writes: S.writes,
  }
}

// ---- engine-facing helpers (top-level, so the validator can follow `$`) -------

async function publish($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, view, () => snapshot(now))
}

async function detect($: EngineInterface): Promise<void> {
  const [apiKey, authToken, bedrock, vertex, foundry, baseUrl, bedrockUrl, ttlEnv, enable1h, force5m] =
    await Promise.all([
      $.env.get('ANTHROPIC_API_KEY'),
      $.env.get('ANTHROPIC_AUTH_TOKEN'),
      $.env.get('CLAUDE_CODE_USE_BEDROCK'),
      $.env.get('CLAUDE_CODE_USE_VERTEX'),
      $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
      $.env.get('ANTHROPIC_BASE_URL'),
      $.env.get('ANTHROPIC_BEDROCK_BASE_URL'),
      $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      $.env.get('ENABLE_PROMPT_CACHING_1H'),
      $.env.get('FORCE_PROMPT_CACHING_5M'),
    ])
  if (bedrock === '1' || bedrock === 'true') S.provider = 'bedrock'
  else if (vertex === '1' || vertex === 'true') S.provider = 'vertex'
  else if (foundry === '1' || foundry === 'true') S.provider = 'foundry'
  else if (baseUrl) S.provider = 'gateway'
  else if (apiKey || authToken) S.provider = 'api-key'
  else S.provider = 'subscription'
  if (bedrockUrl && S.provider === 'bedrock') S.provider = 'gateway'
  S.force5m = force5m === '1'
  S.subagentTtlEnv = await $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL')

  let settingTtl: unknown
  try {
    settingTtl = (await $.settings.read()).promptCacheTtl
  } catch {}

  // Mirrors Claude Code's own precedence for the main conversation's TTL.
  const o = S.o
  if (o.ttl === '5m' || o.ttl === '1h') [S.ttl, S.ttlSource] = [o.ttl, 'plugin config']
  else if (force5m === '1') [S.ttl, S.ttlSource] = ['5m', 'FORCE_PROMPT_CACHING_5M']
  else if (ttlEnv === '5m' || ttlEnv === '1h') [S.ttl, S.ttlSource] = [ttlEnv, 'CLAUDE_CODE_PROMPT_CACHE_TTL']
  else if (settingTtl === '5m' || settingTtl === '1h') [S.ttl, S.ttlSource] = [settingTtl, 'promptCacheTtl setting']
  else if (enable1h === '1') [S.ttl, S.ttlSource] = ['1h', 'ENABLE_PROMPT_CACHING_1H']
  else if (S.provider === 'subscription') [S.ttl, S.ttlSource] = ['1h', 'subscription default']
  else [S.ttl, S.ttlSource] = ['5m', `${S.provider} default`]

  // Provider limits on the TTL that was asked for.
  if (S.ttl === '1h' && S.provider === 'bedrock' && BEDROCK_5M_ONLY.test(S.model)) {
    ;[S.ttl, S.ttlSource] = ['5m', 'bedrock: this model supports the 5-minute TTL only']
  }
  if (S.ttl === '1h' && S.provider === 'gateway') {
    S.ttlSource += ' (needs the gateway to forward cache_control ttl and the anthropic-beta header)'
  }
}

// A subscription gets the 1h TTL only within plan usage; past the limit Claude
// Code drops the main conversation to 5m. Refine from the rate-limit windows.
function refineSubscriptionTtl(rateLimits: SessionUsage['rateLimits']): void {
  if (S.provider !== 'subscription' || !S.ttlSource.startsWith('subscription')) return
  const over = rateLimits.some((l) => l.percentUsed >= 100)
  S.ttl = over ? '5m' : '1h'
  S.ttlSource = over ? 'subscription over plan usage' : 'subscription default'
}

function clearWarming(): void {
  S.timer?.cancel()
  S.timer = undefined
  S.warming = false
}

// An idle period that spent on pings and didn't end in a warm return is a loss.
// Two in a row and automatic warming pauses until /cachewarm on: a pattern of
// leaving for longer than the break-even point should not keep costing.
function closeIdlePeriod($: EngineInterface): void {
  const pinged = S.idlePings > 0
  const realized = S.idleRealized
  S.idlePings = 0
  S.idleRealized = false
  if (!pinged) return
  if (realized) {
    S.consecutiveLosses = 0
    return
  }
  S.consecutiveLosses += 1
  if (S.consecutiveLosses >= 2 && !S.paused) {
    S.paused = `${S.consecutiveLosses} idle periods spent on pings without a warm return`
    $.ui.log(`paused: ${S.paused}. Run /cachewarm on to resume, or set a shorter stopFraction.`)
  }
}

async function stopWarming($: EngineInterface, why: string): Promise<void> {
  const wasWarming = S.warming
  clearWarming()
  if (!wasWarming) return
  $.ui.log(`stopped: ${why} · ${S.idlePings} pings, ${fmtUsd(S.idleSpent)}`)
  await publish($)
  if (S.o.endAction === 'compact' && S.idlePings > 0 && !S.turnRunning) {
    $.ui.log('compacting while the cache is still warm, so the rebuild is small')
    try {
      await $.session.compact({ instructions: 'cache-warm: compacting at the break-even point.' })
    } catch (err) {
      $.ui.log(`compact failed: ${String(err)}`)
    }
  }
}

function schedulePing($: EngineInterface, now: number): void {
  S.timer?.cancel()
  S.nextPingAt = Math.max(now + 1000, S.lastRequestAt + intervalMs())
  if (S.nextPingAt > S.stopAt) {
    void stopWarming($, mode() === 'auto' ? 'break-even reached; letting the cache lapse' : 'duration reached')
    return
  }
  S.timer = $.clock.after(S.nextPingAt - now, () => {
    void ping($)
  })
  void publish($)
}

async function startWarming($: EngineInterface, now: number, force = false): Promise<void> {
  if (mode() === 'off' || S.warming) return
  if (S.paused && !force) return
  if (S.mainWrites >= 2 && !force) {
    // The main thread itself keeps rewriting a prefix that should have been
    // warm: caching isn't working on this provider or model, so pings would
    // write too. Leave it alone until a real turn reads the cache again.
    if (S.o.verbose) $.ui.log('not warming: the last two requests rewrote the prefix; caching looks unhealthy here')
    return
  }
  if (tooSlowForTtl() && !force) {
    S.paused = `ping round-trips up to ${Math.round(S.rttMax / 1000)}s are too slow for a ${S.ttl} cache; use promptCacheTtl 1h`
    $.ui.log(`paused: ${S.paused}`)
    await publish($)
    return
  }
  const minimum = minCacheable(S.model)
  if (S.prefixTokens < minimum) {
    // Below the model's minimum cacheable prefix there is nothing to keep warm.
    try {
      S.prefixTokens = (await $.session.usage()).context.tokens ?? 0
    } catch {}
    if (S.prefixTokens < minimum) return
  }
  S.warming = true
  S.idlePings = S.idleMisses = 0
  S.idleSpent = S.idleSpentPct = 0
  S.idleRealized = false
  S.avgPingUsd = undefined
  S.retryBackoffMs = 0
  S.idleStartAt = S.lastRequestAt || now
  S.stopAt = planStopAt(S.idleStartAt)
  if (S.stopAt <= now) {
    S.warming = false
    return
  }
  schedulePing($, now)
  if (S.o.verbose) {
    const e = economics(S.prefixTokens, S.ttl, priceNow(), S.avgPingUsd)
    $.ui.log(
      `warming on: ${S.ttl} cache via ${S.provider}, ${fmtK(S.prefixTokens)} tokens on ${S.model || 'unknown model'}; ` +
        `ping ≈ ${fmtUsd(e.ping)} every ${fmtMin(intervalMs())}, warm return saves ${fmtUsd(e.saving)}, ` +
        `break-even ${e.pings.toFixed(1)} pings; stops ${fmtClock(S.stopAt)}`,
    )
  }
}

function fiveHour(s?: SessionUsage): number | undefined {
  return s?.rateLimits.find((l) => l.kind === 'five_hour')?.percentUsed
}

async function ping($: EngineInterface): Promise<void> {
  if (!S.warming || S.turnRunning || S.pinging) return
  const now0 = await $.clock.now()

  // Guard 1: never ping a cache that may already be gone. The TTL runs from
  // the request's start at the API, and the body takes time to upload, so if
  // the expected arrival is past expiry the ping would be a full rewrite.
  const expiresAt = S.lastRequestAt + TTL_MS[S.ttl]
  const arrival = now0 + Math.max(1000, S.rttEma / 2)
  if (arrival >= expiresAt) {
    await stopWarming(
      $,
      `the ping window was missed (cache expired ${fmtClock(expiresAt)}; a sleep, a stall or a slow link); not rewriting it`,
    )
    return
  }

  S.pinging = true
  let before: SessionUsage | undefined
  try {
    before = await $.session.usage()
  } catch {}
  // A fork falls in Claude Code's "everything else" TTL bucket, which defaults
  // to five minutes even when the main conversation is on the hour. While the
  // session is idle no subagent is running, so for the ping alone ask for the
  // main conversation's TTL, then put the variable back the way it was.
  const alignTtl = S.o.matchPingTtl && S.ttl === '1h' && !S.force5m && S.subagentTtlEnv !== '1h'
  if (alignTtl) await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', '1h')
  const t0 = await $.clock.now()
  let r: Awaited<ReturnType<EngineInterface['model']['fork']>>
  try {
    r = await $.model.fork({ prompt: PING_PROMPT })
  } finally {
    S.pinging = false
    if (alignTtl) await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', S.subagentTtlEnv)
  }
  const t1 = await $.clock.now()
  noteRtt(t1 - t0)

  if (!('usage' in r)) {
    await stopWarming($, 'nothing to fork yet (no completed turn in this conversation)')
    return
  }
  if (!r.isAnswered && r.reason === 'api-error') {
    S.idleMisses += 1
    S.misses += 1
    const retryable = r.error === 'rate_limit' || r.error === 'overloaded' || r.error === 'server_error' || r.status === null
    $.ui.log(`ping failed: ${r.error} (${r.status ?? 'no response'})`)
    if (!retryable || S.idleMisses >= 3) {
      await stopWarming($, retryable ? 'three failed pings' : `ping refused: ${r.error}`)
      return
    }
    // Guard 2: retry with backoff, but only inside the window; a retry that
    // would land after expiry is pointless and expensive, so give up instead.
    S.retryBackoffMs = S.retryBackoffMs ? Math.min(S.retryBackoffMs * 2, 120_000) : 15_000
    const retryAt = t1 + S.retryBackoffMs
    if (retryAt + Math.max(1000, S.rttEma / 2) >= expiresAt - 5_000) {
      await stopWarming($, 'the API kept refusing pings until the cache expired')
      return
    }
    S.timer?.cancel()
    S.nextPingAt = retryAt
    S.timer = $.clock.after(S.retryBackoffMs, () => {
      void ping($)
    })
    await publish($)
    return
  }
  S.retryBackoffMs = 0
  const u = r.usage
  const outcome = classify(u, S.prefixTokens)
  const prevRequestAt = S.lastRequestAt
  // A hit (or a partial read) refreshed the entry from this request's start.
  // A write made a new entry, also from this request's start, but at full cost.
  if (outcome !== 'none') S.lastRequestAt = t0

  let after: SessionUsage | undefined
  try {
    after = await $.session.usage()
  } catch {}
  const ledger = before?.cost && after?.cost ? after.cost.usd - before.cost.usd : undefined
  const cost = ledger !== undefined && ledger > 0 ? ledger : usd(u, priceNow(), S.ttl)
  const pctBefore = fiveHour(before)
  const pctAfter = fiveHour(after)
  if (pctBefore !== undefined && pctAfter !== undefined && pctAfter >= pctBefore) {
    S.idleSpentPct += pctAfter - pctBefore
    S.spentPct += pctAfter - pctBefore
  }
  if (after) refineSubscriptionTtl(after.rateLimits)

  S.idlePings += 1
  S.pings += 1
  S.idleSpent += cost
  S.spent += cost
  S.lastPingUsd = cost
  S.avgPingUsd = S.idleSpent / S.idlePings
  if (!S.warming) {
    // A turn started while the ping was in flight: the cost counts, the rest doesn't.
    await publish($)
    return
  }

  if (S.o.verbose || outcome !== 'hit') {
    $.ui.log(
      `ping #${S.idlePings} ${outcome}: read ${fmtK(u.cache_read_input_tokens)} · wrote ${fmtK(u.cache_creation_input_tokens)} · ` +
        `uncached ${fmtK(u.input_tokens)} · out ${u.output_tokens} · ${fmtUsd(cost)} · ${((t1 - t0) / 1000).toFixed(1)}s`,
    )
  }

  // Guard 3: a ping that wrote or missed is a loss event. Work out why and
  // stop before it can happen twice.
  if (outcome !== 'hit') {
    S.idleMisses += 1
    S.misses += 1
    if (outcome === 'write') S.writes += 1
    const sentWithin = t0 - (prevRequestAt || t0) // how long after the last refresh this ping went out
    const fresh = sentWithin < TTL_MS[S.ttl] - marginMs()
    if (outcome === 'none') {
      S.paused = 'pings are not cached at all on this provider or model (both counts zero)'
      await stopWarming($, S.paused)
      return
    }
    if (S.idlePings === 1 && fresh) {
      // The cache was certainly alive and the fork still didn't read it: the
      // fork's request differs from the main thread's (a gateway rewriting
      // cache_control, a provider quirk). Every ping would write, so pause.
      // Bedrock's cross-region routing can write once under load, so there it
      // takes two idle periods in a row before the session is paused.
      S.firstPingWrites += 1
      if (S.provider === 'bedrock' && S.firstPingWrites < 2) {
        await stopWarming($, 'the first ping rewrote a live cache (Bedrock cross-region load?); not pinging again this idle period')
        return
      }
      S.paused = 'the first ping rewrote a live cache: the fork request differs from the main thread (gateway or provider)'
      await stopWarming($, S.paused)
      return
    }
    if (!fresh) {
      // Expired in flight: the link is slower than the margin allowed for.
      noteRtt(Math.max(t1 - t0, marginMs()))
      $.ui.log(`the cache expired before this ping arrived; ping margin raised to ${fmtCountdown(marginMs())}`)
      if (tooSlowForTtl()) {
        S.paused = `the connection is too slow for a ${S.ttl} cache (margin ${fmtCountdown(marginMs())}); use promptCacheTtl 1h`
        await stopWarming($, S.paused)
        return
      }
    }
    if (S.idleMisses >= 2) {
      S.paused = 'two pings in one idle period rewrote or missed the cache'
      await stopWarming($, S.paused)
      return
    }
  }

  if (outcome === 'hit') S.firstPingWrites = 0

  // Guard 4: once this idle period has spent what a cold rewrite would cost,
  // pinging can no longer come out ahead, whatever the plan said.
  const e = economics(S.prefixTokens, S.ttl, priceNow(), S.avgPingUsd)
  if (S.idleSpent >= e.saving * Math.max(0.05, S.o.stopFraction)) {
    await stopWarming($, `spent ${fmtUsd(S.idleSpent)} this idle period, the cost of a cold rewrite; letting it lapse`)
    return
  }
  // Re-plan with the measured ping cost: the break-even point moves if pings
  // cost more (thinking tokens) or less than the estimate.
  if (mode() === 'auto') S.stopAt = planStopAt(S.idleStartAt)
  schedulePing($, t1)
}

function calcText(): string {
  const p = priceNow()
  const N = S.prefixTokens || 100_000
  const rows = (['5m', '1h'] as Ttl[]).map((t) => {
    const e = economics(N, t, p, t === S.ttl ? S.avgPingUsd : undefined)
    const iv = defaultIntervalMs(t)
    return (
      `${t}: write ${WRITE_MULT[t]}x, read ${p.read}x → warm return saves ${fmtUsd(e.saving)}, ` +
      `ping ≈ ${fmtUsd(e.ping)} every ${fmtMin(iv)}, break-even ${e.pings.toFixed(1)} pings = ${fmtMin(e.pings * iv)}`
    )
  })
  return (
    `model ${S.model || '?'} · ${S.provider} · TTL ${S.ttl} (${S.ttlSource}) · prefix ${fmtK(N)} tokens` +
    (S.prefixTokens ? '' : ' (assumed; no turn yet)') +
    ` · $${p.input}/MTok base input${p.known ? '' : ' (model not in table, using $3)'}` +
    (S.provider === 'bedrock' && !S.o.inputPricePerMTok ? ' (Bedrock list ≈ Anthropic +10%; verify on the AWS pricing page)' : '') +
    (S.provider === 'gateway' && !S.o.inputPricePerMTok ? " (gateway: set inputPricePerMTok to your upstream's rate)" : '') +
    '\n' +
    rows.join('\n') +
    `\nBreak-even time does not depend on prefix size: the saving and each ping both scale with it. ` +
    `Only the TTL, the model's read multiplier and the interval set it.` +
    (S.ttl === '5m'
      ? `\nTip: a 1h TTL (promptCacheTtl: "1h") costs 0.75x extra only on each turn's new tokens, and then one ping per 55 min keeps it warm instead of one per 4 min.`
      : '')
  )
}

function statusText(now: number): string {
  const totals =
    `session: ${S.pings} pings, ${fmtUsd(S.spent)} spent${S.spentPct ? ` (${S.spentPct.toFixed(1)}% of the 5h window)` : ''}, ` +
    `${fmtUsd(S.saved)} saved, net ${fmtUsd(S.saved - S.spent)}; ` +
    `${S.returnsWarm} warm return${S.returnsWarm === 1 ? '' : 's'}, ${S.returnsCold} cold, ${S.misses} misses`
  const head =
    `${S.provider} · TTL ${S.ttl} (${S.ttlSource}) · model ${S.model || '?'} · prefix ${fmtK(S.prefixTokens)} tokens · ` +
    `ping margin ${fmtCountdown(marginMs())}${S.rttMax ? ` (slowest ping ${(S.rttMax / 1000).toFixed(1)}s)` : ''}` +
    (S.paused ? `\nPAUSED: ${S.paused} (/cachewarm on to resume)` : '') +
    (S.mainWrites >= 2 ? '\ncaching looks unhealthy: the last two requests rewrote the prefix' : '')
  const ph = phase(now)
  if (ph === 'none') return `cache-warm (mode ${mode()}) · ${head}\nno turn yet; warming starts when a turn completes.\n${totals}`
  if (!S.warming) {
    const left = S.lastRequestAt + TTL_MS[S.ttl] - now
    const e = economics(S.prefixTokens, S.ttl, priceNow(), S.avgPingUsd)
    const state =
      ph === 'turn'
        ? 'turn in progress (every request refreshes the cache)'
        : ph === 'warm'
          ? `warm, expires in ${fmtCountdown(left)} (not warming: mode ${mode()})`
          : `cold: the next turn rewrites ${fmtK(S.prefixTokens)} tokens (≈ ${fmtUsd(e.saving + (S.prefixTokens * priceNow().input * priceNow().read) / 1e6)})`
    return `cache-warm · ${head}\n${state}\n${totals}`
  }
  const e = economics(S.prefixTokens, S.ttl, priceNow(), S.avgPingUsd)
  return (
    `warming · ${head}\n` +
    `cache expires in ${fmtCountdown(S.lastRequestAt + TTL_MS[S.ttl] - now)}; next ping ${fmtClock(S.nextPingAt)} (${fmtCountdown(S.nextPingAt - now)}), ` +
    `interval ${fmtMin(intervalMs())}; stops ${fmtClock(S.stopAt)} (${mode()})\n` +
    `this idle period: ${S.idlePings} pings, ${fmtUsd(S.idleSpent)}${S.idleSpentPct ? ` / ${S.idleSpentPct.toFixed(1)}% of the 5h window` : ''}; ` +
    `last ping ${S.lastPingUsd === undefined ? '-' : fmtUsd(S.lastPingUsd)}; a warm return saves ${fmtUsd(e.saving)}; break-even ${e.pings.toFixed(1)} pings\n` +
    totals
  )
}

// ---- hooks ---------------------------------------------------------------------

export const register: Register = (on, options) => {
  S.o = { ...S.o, ...(options as unknown as Partial<Options>) }

  on('session.start', async ($, e, next) => {
    await detect($)
    try {
      S.model = await $.session.model()
    } catch {}
    try {
      refineSubscriptionTtl((await $.session.usage()).rateLimits)
    } catch {}
    // Session totals live in $.state, which survives a hot reload of the module.
    const kept = await read($, view)
    if (kept) {
      S.pings = kept.pings
      S.spent = kept.spent
      S.saved = kept.saved
      S.spentPct = kept.spentPct
      S.returnsWarm = kept.returnsWarm
      S.returnsCold = kept.returnsCold
      S.misses = kept.misses
      S.writes = kept.writes
      S.rttMax = kept.rttMs
      S.rttEma = kept.rttMs ? kept.rttMs / 1.5 : 0
      S.paused = kept.paused
      S.prefixTokens = kept.prefixTokens
      S.lastRequestAt = kept.lastRequestAt
      S.model = kept.model || S.model
    }
    try {
      await $.command.register({
        name: 'cachewarm',
        description: 'Prompt-cache warmer: status, calc, on, off, auto, manual <min>, interval <min>, ping, stop, band',
        argumentHint: '[status|calc|on|off|auto|manual <min>|interval <min>|ping|stop|band]',
        immediate: true,
      })
    } catch {}
    // One ticker for the band's countdowns; it only writes while something counts down.
    S.ticker?.cancel()
    S.ticker = $.clock.every(1000, () => {
      void $.clock.now().then((now) => {
        const ph = phase(now)
        if (ph === 'warming' || ph === 'warm') void update($, view, () => snapshot(now))
      })
    })
    await publish($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    clearWarming()
    S.ticker?.cancel()
    S.ticker = undefined
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      S.gapPings = S.idlePings
      // Did pings carry the cache through an idle period longer than the TTL?
      // Without them the first request now would be a cold rewrite. The first
      // turn.step of this turn settles it by what the API actually served.
      const idleMs = S.idleStartAt ? now - S.idleStartAt : 0
      if (S.idlePings > 0 && idleMs > TTL_MS[S.ttl]) {
        const ec = economics(S.prefixTokens, S.ttl, priceNow(), S.avgPingUsd)
        S.pendingReturn = { prefix: S.prefixTokens, saving: ec.saving }
      } else {
        S.pendingReturn = undefined
        closeIdlePeriod($) // pings inside the TTL could not have saved anything
      }
      S.turnRunning = true
      clearWarming() // the user is back: every real request refreshes the cache
      await publish($)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // The TTL runs from the request's start, not from the end of its response:
    // a long generation eats into the window, so take the time before sending.
    const started = e.agentId === undefined ? await $.clock.now() : 0
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) {
      const u = result.usage
      const outcome = classify(u, S.prefixTokens)
      const gap = S.lastRequestAt ? started - S.lastRequestAt : 0

      if (S.pendingReturn) {
        const hit = u.cache_read_input_tokens >= 0.8 * S.pendingReturn.prefix
        if (hit) {
          S.saved += S.pendingReturn.saving
          S.returnsWarm += 1
          S.idleRealized = true
          if (S.o.verbose) $.ui.log(`warm return: saved ${fmtUsd(S.pendingReturn.saving)}`)
        } else {
          S.returnsCold += 1
          $.ui.log(`cold return despite ${S.gapPings} pings: the API rewrote ${fmtK(u.cache_creation_input_tokens)} tokens`)
        }
        S.pendingReturn = undefined
        closeIdlePeriod($)
      }

      // Learn the TTL actually in effect from gaps that had no pings: a hit
      // after more than five minutes can only come from a one-hour entry, and
      // a rewrite inside the hour after a five-minute gap means five minutes.
      if (S.gapPings === 0 && S.prefixTokens > 0 && gap > TTL_MS['5m'] + marginMs() && gap < TTL_MS['1h'] - marginMs()) {
        if (outcome === 'hit' && S.ttl !== '1h') [S.ttl, S.ttlSource] = ['1h', `observed: hit after a ${fmtMin(gap)} gap`]
        else if (outcome === 'write' && S.ttl !== '5m') [S.ttl, S.ttlSource] = ['5m', `observed: rewrite after a ${fmtMin(gap)} gap`]
      }
      // Cache health of the main thread itself: a rewrite of a prefix that
      // should still have been warm, twice in a row, means caching isn't
      // working here, and pings would only add to the bill.
      if (S.prefixTokens > minCacheable(S.model) && gap > 0 && gap < TTL_MS[S.ttl] - marginMs()) {
        if (outcome === 'write' || outcome === 'none') S.mainWrites += 1
        else if (outcome === 'hit') S.mainWrites = 0
        if (S.mainWrites === 2) {
          $.ui.log(
            outcome === 'none'
              ? 'the last two requests were billed uncached: a gateway may be stripping cache_control; warming is off until a request reads the cache'
              : 'the last two requests rewrote the prefix; warming is off until a request reads the cache',
          )
        }
      }
      S.gapPings = 0

      // Everything the request carried is the prefix the next cold turn rewrites.
      S.prefixTokens = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
      S.model = u.model || S.model
      S.lastRequestAt = started
      void publish($)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      S.turnRunning = false
      const now = await $.clock.now()
      if (!S.lastRequestAt) S.lastRequestAt = now
      void startWarming($, now)
      await publish($)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    refineSubscriptionTtl(e.rateLimits)
    return next(e)
  })

  // Claude Code compacts an idle 1h-TTL conversation shortly before the cache
  // expires. While we are keeping it warm that would discard history for no
  // reason, so skip it (a manual /compact is never skipped).
  on('session.compact', { trigger: 'auto' }, async ($, e, next) => {
    if (S.warming && !S.turnRunning && S.o.blockIdleCompaction && e.agentId === undefined) {
      return { skip: 'cache-warm is keeping this conversation warm; idle compaction skipped' }
    }
    return next(e)
  })

  // The band above the prompt: TTL, cache countdown, next ping, session totals.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (!S.o.showBand || e.props.hasSurvey || v === null || (await read($, hidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const narrow = e.props.bodyColumns < 100
    const left = v.lastRequestAt + TTL_MS[v.ttl] - v.now
    const ttlText = `TTL ${v.ttl}${narrow ? '' : ` (${v.ttlSource})`}`
    const size = v.prefixTokens ? ` · ${fmtK(v.prefixTokens)} tok` : ''

    let stateColor: 'success' | 'warning' | 'subtle' | 'claude' = 'subtle'
    let state = ''
    switch (v.phase) {
      case 'none':
        state = 'waiting for the first turn'
        break
      case 'turn':
        stateColor = 'claude'
        state = 'turn in progress · cache refreshing'
        break
      case 'warming':
        stateColor = 'success'
        state =
          `warm · expires ${fmtCountdown(left)} · ping in ${fmtCountdown(v.nextPingAt - v.now)}` +
          (narrow ? '' : ` · stops ${fmtClock(v.stopAt)}${v.mode === 'auto' ? ' (break-even)' : ''}`)
        break
      case 'warm':
        stateColor = 'success'
        state = `warm · expires ${fmtCountdown(left)}${v.mode === 'off' ? ' · warming off' : ' · not warming'}`
        break
      case 'cold':
        stateColor = 'warning'
        state = `cold · next turn rewrites ${fmtK(v.prefixTokens)} tok`
        break
      case 'paused':
        stateColor = 'warning'
        state = `paused · ${narrow ? 'see /cachewarm' : v.paused}`
        break
    }
    if (v.phase === 'warming' && !narrow) state += ` · margin ${fmtCountdown(v.marginMs)}`
    const net = v.saved - v.spent
    const spentText = v.spentPct > 0 ? `${fmtUsd(v.spent)} (${v.spentPct.toFixed(1)}% of 5h)` : fmtUsd(v.spent)
    const totals =
      `${v.pings} ping${v.pings === 1 ? '' : 's'} · spent ${spentText} · saved ${fmtUsd(v.saved)} · net ` +
      (net >= 0 ? '+' : '') +
      fmtUsd(net) +
      (narrow || v.misses === 0 ? '' : ` · ${v.misses} miss${v.misses === 1 ? '' : 'es'}`) +
      (narrow || v.writes === 0 ? '' : ` · ${v.writes} rewrite${v.writes === 1 ? '' : 's'}`)

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>cache </Text>
          <Text color={stateColor}>{state}</Text>
          <Text dimColor>
            {' · '}
            {ttlText}
            {size}
          </Text>
        </Box>
        <Box>
          <Text dimColor>
            {'      '}
            {totals}{' '}
          </Text>
          <Button key="hide" label="hide" plain onPress={() => update($, hidden, () => true)} />
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'cachewarm' }, async ($, e) => {
    const [verb = 'status', arg] = (e.args || '').trim().split(/\s+/)
    const now = await $.clock.now()
    const n = Number(arg)
    switch (verb) {
      case 'off':
        S.overrideMode = 'off'
        await stopWarming($, 'turned off')
        return { text: 'cache-warm off for this session.' }
      case 'on':
      case 'auto': {
        S.overrideMode = 'auto'
        const resumed = S.paused
        S.paused = ''
        S.consecutiveLosses = 0
        S.mainWrites = 0
        if (!S.warming && !S.turnRunning) void startWarming($, now, true)
        return {
          text:
            `cache-warm auto: ping every ${fmtMin(intervalMs())} (margin ${fmtCountdown(marginMs())}) until break-even × ${S.o.stopFraction}.` +
            (resumed ? ` Resumed after: ${resumed}.` : ''),
        }
      }
      case 'manual':
        S.overrideMode = 'manual'
        if (n > 0) S.overrideDuration = n
        clearWarming()
        void startWarming($, now)
        return {
          text: `cache-warm manual: ping every ${fmtMin(intervalMs())} for ${S.overrideDuration ?? S.o.durationMinutes} min.`,
        }
      case 'interval':
        if (!(n > 0)) return { text: 'usage: /cachewarm interval <minutes>' }
        S.overrideInterval = n * 60_000
        if (S.warming) schedulePing($, now)
        return { text: `interval ${fmtMin(intervalMs())} (clamped to the ${S.ttl} TTL minus ${SAFETY_MS / 1000}s).` }
      case 'stop':
        await stopWarming($, 'stopped by /cachewarm stop')
        return { text: 'stopped; the cache will lapse after the TTL.' }
      case 'ping': {
        const ph = phase(now)
        if ((ph === 'cold' || ph === 'paused') && arg !== 'force') {
          return {
            text: `the cache expired ${fmtClock(S.lastRequestAt + TTL_MS[S.ttl])}; a ping now would rewrite ${fmtK(S.prefixTokens)} tokens, not read them. /cachewarm ping force to do it anyway.`,
          }
        }
        if (ph === 'turn') return { text: 'a turn is running; it refreshes the cache itself.' }
        if (!S.warming) {
          S.warming = true
          S.idleStartAt = S.idleStartAt || now
          S.stopAt = now + 60_000
        }
        await ping($)
        return {
          text:
            S.lastPingUsd === undefined
              ? 'no ping made'
              : `pinged: ${fmtUsd(S.lastPingUsd)}, ${S.idleMisses ? 'MISS' : 'cache hit'}.`,
        }
      }
      case 'band': {
        const isHidden = await read($, hidden)
        await update($, hidden, () => !isHidden)
        return { text: isHidden ? 'band shown' : 'band hidden (/cachewarm band to show it again)' }
      }
      case 'calc':
        return { text: calcText() }
      default:
        return { text: statusText(now) }
    }
  })
}
