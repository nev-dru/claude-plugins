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
import type { Register, EngineInterface, ModelCompleteResult, ModelUsage, SessionUsage, TurnUsage } from 'claude-code'

import type { CacheView, ColdPrefix, KeptState, Phase, Ttl } from '../types'

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
  forceTtl: 'auto' | '1h' | '5m' | 'off'
  showBand: boolean
  verbose: boolean
}

// Base input price in USD per MTok, the cache-read multiplier vs base, and the
// minimum cacheable prefix in tokens, from the Claude pricing/caching docs.
// Output is ~5x base input across the lineup. Order matters: first match wins.
// Bedrock keeps the same multipliers at a ~10% higher base (third-party price
// trackers, Oct 2026; verify on the AWS pricing page): BEDROCK_MARKUP below.
// A gateway's upstream rates are unknown here: set inputPricePerMTok.
// Claude 3.x ids put the version first (claude-3-5-haiku-20241022).
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
  { re: /3-5-haiku|haiku-3-5/, input: 0.8, read: 0.1, min: 2048 },
]
const BEDROCK_MARKUP = 1.1
// Models whose Bedrock integration supports the 5-minute TTL only: the Claude
// 3 generation (3.7/3.5 Sonnet, 3.5 Haiku). Sonnet 4 and Opus 4.0/4.1 are
// not confirmed either way.
const BEDROCK_5M_ONLY = /claude-3-/
const OUTPUT_RATIO = 5
const WRITE_MULT: Record<Ttl, number> = { '5m': 1.25, '1h': 2 }
const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const SAFETY_MS = 45_000 // the lifetime runs from the request's start; pings take time
const COMPACT_FOR_ROOM_PCT = 75 // a compaction this close to the auto-compact threshold is for room, never only for idleness
const RECORD_PREFIX = 'ttl:' // $.store, one key per conversation: the TTL this mod set for it
const RECORD_MS = 30 * 24 * 60 * 60_000 // how long such a record counts
const PRUNED_KEY = 'records-pruned-at' // $.store: when expired records were last dropped
const PRUNE_MS = 24 * 60 * 60_000
const MAX_MINUTES = 24 * 60 // the longest /cachewarm manual or interval
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

// What a response's usage says the API did with the prefix.
export type CacheOutcome = 'hit' | 'partial' | 'write' | 'none'
export function classify(u: ModelUsage, prefix: number): CacheOutcome {
  if (prefix <= 0) return 'none'
  const read = u.cache_read_input_tokens / prefix
  const wrote = u.cache_creation_input_tokens / prefix
  // A fork re-sends the history verbatim, but the last typed message can carry
  // per-request attachments that differ, so a ping may rewrite that one turn's
  // delta while reading everything before it. Judge by what was READ.
  if (read >= 0.8) return 'hit'
  if (read >= 0.3) return 'partial'
  if (wrote >= 0.5) return 'write'
  if (read > 0.02 || wrote > 0.02) return 'partial'
  return 'none'
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
// What a hot reload picks up again, written only when it changes.
const keep = atom({ plugin: 'cache-warm', key: 'keep' } as const, null)

type PendingReturn = { prefix: number; saving: number; pings: number; autoPings: number }

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
    forceTtl: 'auto',
    showBand: true,
    verbose: false,
  } as Options,
  // session facts
  provider: 'subscription' as Provider,
  ttlBase: '5m' as Ttl, // the main conversation's TTL as configured or observed, before plan and provider limits
  ttlBaseSource: 'default',
  ttl: '5m' as Ttl, // what the main conversation's requests write (the entry's lifetime): settleTtl()
  ttlSource: 'default',
  forkTtl: '' as '' | Ttl, // the subagent bucket's TTL when set explicitly; '' = a fork inherits the main's
  forkTtlSource: '',
  forcedTtl: '' as '' | Ttl, // the TTL this mod set for the process, if any
  recordPending: false, // the conversation running now still needs its forced TTL on record
  overPlan: false, // subscription: a usage window is at 100%
  model: '',
  sessionModel: '', // $.session.model() when the last turn ended: a change while idle empties the cache
  prefixTokens: 0, // size of the cached prefix the next cold turn would rewrite
  lastRequestAt: 0, // start of the last main-thread request or ping (the TTL runs from there)
  coldPrefix: '' as ColdPrefix, // the next request sends a prefix nothing cached, and why
  lastRequestTtl: '5m' as Ttl, // the TTL mode the last main-thread request was sent in
  turnRunning: false,
  turnSteps: 0, // main-thread requests in the running turn
  forceNext: false, // /cachewarm on arrived mid-turn: the next idle period starts with its holds lifted
  // warming state
  warming: false,
  stopAt: 0,
  nextPingAt: 0,
  timer: undefined as { cancel: () => void } | undefined,
  ticker: undefined as { cancel: () => void } | undefined,
  publishedPhase: '' as Phase | '',
  keptJson: '', // the kept state as last written
  bandHidden: false,
  idleNote: '', // why warming is not running this idle period
  // this idle period: set by beginIdlePeriod, and by the pings that count in it
  idleGen: 0, // which idle period; a ping that resolves in another one counts in the session only
  idleStartAt: 0,
  idleTtl: '5m' as Ttl, // the TTL mode the live entry was written in; pings must go out in the same one
  idlePings: 0,
  idleAutoPings: 0, // pings auto mode's timer sent: the only ones the session cap judges
  idleWrites: 0, // pings that rewrote the prefix
  idleErrors: 0, // pings the API refused
  idleSpent: 0,
  idleSpentPct: 0,
  avgPingUsd: undefined as number | undefined,
  retryBackoffMs: 0, // after a 429/overloaded answer
  lastPingUsd: undefined as number | undefined,
  // a return to check: did pings keep the cache warm through an idle period
  // longer than the TTL? Resolved by the first request of the next turn.
  pendingReturn: undefined as PendingReturn | undefined,
  // guardrails
  pinging: '' as '' | 'auto' | 'other', // a fork is in flight, and whether auto mode's timer sent it
  pingWanted: false, // a timer's ping found one in flight: send it when that one lands
  rttMax: 0, // slowest ping round-trip this session, ms
  rttEma: 0, // smoothed ping round-trip, ms
  paused: '', // why automatic warming is off until /cachewarm on
  consecutiveLosses: 0, // idle periods that spent on pings and never came back warm
  firstPingWrites: 0, // pinged idle periods in a row whose first ping rewrote a live cache (Bedrock tolerates one)
  compacting: '', // why this mod is compacting, while its own compaction runs
  mainWrites: 0, // consecutive main-thread requests that rewrote a prefix that should have been warm
  gapPings: 0, // pings made since the last real request, judged by the next one
  gapTtl: '5m' as Ttl, // the TTL the entry had over that gap
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

// ---- the TTL in force -------------------------------------------------------

function isBedrock5mOnly(provider: Provider, model: string): boolean {
  return provider === 'bedrock' && BEDROCK_5M_ONLY.test(model)
}

function bedrock5mOnly(): boolean {
  return isBedrock5mOnly(S.provider, S.model)
}

// Settles the TTL in force from what was configured (or observed), the plan's
// usage and the provider's limits; run again whenever one of them moves.
// A subscription gets the 1h TTL only within plan usage; past the limit Claude
// Code drops the main conversation to 5m. Whether that drop also overrides a
// CLAUDE_CODE_PROMPT_CACHE_TTL is not measured, so a TTL set there (by the
// user or this mod) is left as it is; the observed-TTL check can still correct it.
function settleTtl(): void {
  let ttl = S.ttlBase
  let source = S.ttlBaseSource
  if (S.provider === 'subscription' && source === 'subscription default' && S.overPlan) {
    ;[ttl, source] = ['5m', 'subscription over plan usage']
  }
  if (ttl === '1h' && bedrock5mOnly()) [ttl, source] = ['5m', 'bedrock: this model supports the 5-minute TTL only']
  if (ttl === '1h' && S.provider === 'gateway') {
    source += ' (needs the gateway to forward cache_control ttl and the anthropic-beta header)'
  }
  S.ttl = ttl
  S.ttlSource = source
}

// What a ping buys. A fork is sent in the subagent bucket, which inherits the
// main conversation's TTL unless it is set explicitly (measured,
// experiments/RESULTS.md 2b), so this follows S.ttl wherever S.ttl moves.
function refreshTtl(): Ttl {
  const ttl = S.forkTtl || S.ttl
  return ttl === '1h' && bedrock5mOnly() ? '5m' : ttl
}

function refreshTtlSource(): string {
  if (!S.forkTtl) return 'inherits the main conversation (measured)'
  return S.forkTtl === '1h' && bedrock5mOnly() ? 'bedrock: 5-minute TTL only' : S.forkTtlSource
}

// A fork in the other TTL mode never reads the main conversation's entries
// (measured): every ping would rewrite the conversation. '' when they agree.
function ttlMismatch(): string {
  const fork = refreshTtl()
  if (!S.forkTtl || fork === S.ttl) return ''
  return (
    `${S.forkTtlSource} is ${fork} while the main conversation writes ${S.ttl} entries; every ping would rewrite the conversation. ` +
    'Set promptCacheTtl and subagentPromptCacheTtl to the same value, or unset the subagent one.'
  )
}

// The TTL in force moved during the idle period (a plan's usage window): a
// fork now goes out in the other TTL mode, which never reads this entry. ''
// when it hasn't. The next turn writes an entry in the new mode.
function ttlMoved(): string {
  if (refreshTtl() === liveTtl()) return ''
  return `the cache TTL moved from ${liveTtl()} to ${refreshTtl()} during this idle period; a ping now would rewrite the conversation`
}

// Learns a one-hour TTL where the TTL is only an auth-mode default: a hit
// after ten minutes with no pings can only come from a one-hour entry (a
// five-minute one may outlive its TTL by a minute or two: RESULTS.md finding
// 2). Rewrites are no evidence: an edited CLAUDE.md, a changed tool list or a
// new day in the system prompt rewrite too, and a TTL wrongly lowered to 5m
// could never be seen again, since pings every four minutes leave no gap.
// Resolves whether it learned one: the request was sent in that mode.
function observeTtl(outcome: CacheOutcome, gap: number): boolean {
  if (S.ttl === '1h' || outcome !== 'hit' || !S.ttlBaseSource.endsWith(' default')) return false
  if (gap <= 2 * TTL_MS['5m'] || gap >= TTL_MS['1h'] - marginMs()) return false
  ;[S.ttlBase, S.ttlBaseSource] = ['1h', `observed: a hit after a ${fmtMin(gap)} gap`]
  settleTtl()
  return true
}

function noteRateLimits(rateLimits: SessionUsage['rateLimits']): void {
  S.overPlan = rateLimits.some((l) => l.percentUsed >= 100)
  settleTtl()
}

// ---- timing ---------------------------------------------------------------------

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
  return marginMs() > TTL_MS[liveTtl()] / 2
}

// The gap before a ping that renews an entry of this TTL.
function intervalFor(ttl: Ttl): number {
  const want =
    S.overrideInterval ?? (S.o.intervalMinutes > 0 ? S.o.intervalMinutes * 60_000 : defaultIntervalMs(ttl))
  return Math.max(30_000, Math.min(want, TTL_MS[ttl] - marginMs()))
}

// The gap between pings. A ping renews the entry in the TTL mode it was
// written in (warming refuses a fork bucket in another mode), so every ping
// of an idle period waits the same.
function intervalMs(): number {
  return intervalFor(liveTtl())
}

function priceNow(): Pricing {
  return pricing(S.model, S.prefixTokens, S.o, S.provider)
}

// The economics of this idle period's entry.
function econNow() {
  return economics(S.prefixTokens, liveTtl(), priceNow(), S.avgPingUsd || undefined)
}

// When the live entry expires, and when a request sent now reaches the API.
function expiresAt(): number {
  return S.lastRequestAt + TTL_MS[liveTtl()]
}
function arrivalAt(now: number): number {
  return now + Math.max(1000, S.rttEma / 2)
}

function periodStart(): number {
  return S.idleStartAt || S.lastRequestAt
}

function noteRtt(ms: number): void {
  S.rttMax = Math.max(S.rttMax, ms)
  S.rttEma = S.rttEma ? 0.7 * S.rttEma + 0.3 * ms : ms
}

function planStopAt(from: number): number {
  if (mode() === 'manual') return from + (S.overrideDuration ?? S.o.durationMinutes) * 60_000
  return from + Math.max(0, S.o.stopFraction) * econNow().pings * intervalMs()
}

// The TTL the live entry got: the mode it was written in when this idle
// period began. The TTL in force can move mid-period (a plan's usage window),
// but an entry keeps the TTL it was written with.
function liveTtl(): Ttl {
  return S.idleStartAt ? S.idleTtl : S.ttl
}

function phase(now: number): Phase {
  if (S.turnRunning) return 'turn'
  if (S.warming) return 'warming'
  if (!S.lastRequestAt) return 'none'
  if (!S.coldPrefix && now < expiresAt()) return 'warm'
  return S.paused || ttlMismatch() ? 'paused' : 'cold'
}

// The session's state a reload of the module would otherwise lose, by the
// names it has in S: restore assigns it back whole.
const KEPT = [
  'coldPrefix', 'idleNote', 'idleTtl', 'idleStartAt', 'idlePings', 'idleAutoPings', 'idleWrites', 'idleErrors',
  'idleSpent', 'idleSpentPct', 'overrideMode', 'overrideInterval', 'overrideDuration', 'mainWrites',
  'consecutiveLosses', 'firstPingWrites', 'paused', 'forcedTtl', 'lastRequestTtl',
] as const satisfies readonly (keyof KeptState & keyof typeof S)[]
const TOTALS = ['pings', 'spent', 'saved', 'spentPct', 'returnsWarm', 'returnsCold', 'misses', 'writes'] as const

function pick<T, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>
}

function keptNow(): KeptState {
  const observed = S.ttlBaseSource.startsWith('observed') ? { ttl: S.ttlBase, source: S.ttlBaseSource } : undefined
  return { ...pick(S, KEPT), observed }
}

function snapshot(now: number): CacheView {
  return {
    now,
    phase: phase(now),
    ttl: S.ttl,
    ttlSource: S.ttlSource,
    refreshTtl: refreshTtl(),
    liveTtl: liveTtl(),
    provider: S.provider,
    model: S.model,
    prefixTokens: S.prefixTokens,
    lastRequestAt: S.lastRequestAt,
    nextPingAt: S.nextPingAt,
    stopAt: S.stopAt,
    mode: mode(),
    marginMs: marginMs(),
    rttMs: S.rttMax,
    paused: S.paused || ttlMismatch(),
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

async function publish($: EngineInterface, now?: number): Promise<void> {
  const at = now ?? (await $.clock.now())
  S.publishedPhase = phase(at)
  await update($, view, () => snapshot(at))
  const k = keptNow()
  const json = JSON.stringify(k)
  if (json === S.keptJson) return
  await update($, keep, () => k)
  S.keptJson = json // once stored: a failed write is tried again by the next publish
}

// The band's countdowns tick once a second, and only while the band is drawn.
// A phase change (warm to cold) is published even with nothing counting down.
async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const ph = phase(now)
  if (ph === 'warming' || ph === 'warm' || ph !== S.publishedPhase) await publish($, now)
}

function syncTicker($: EngineInterface): void {
  const shown = S.o.showBand && !S.bandHidden
  if (shown && !S.ticker) {
    S.ticker = $.clock.every(1000, () => {
      quiet(tick($))
    })
  } else if (!shown && S.ticker) {
    S.ticker.cancel()
    S.ticker = undefined
  }
}

async function setBandHidden($: EngineInterface, isHidden: boolean): Promise<void> {
  S.bandHidden = isHidden
  await update($, hidden, () => isHidden)
  syncTicker($)
  if (!isHidden) await publish($) // the band comes back with what is true now
}

type ProviderEnv = { provider: Provider; force5m: boolean; enable1h: boolean; mainEnv?: string; subEnv?: string }

// A flag counts as Claude Code counts it: 1, true, yes or on, in any case.
function truthy(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())
}

function asTtl(v: unknown): Ttl | undefined {
  return v === '5m' || v === '1h' ? v : undefined
}

// A provider's base URL on the provider's own hosts (a Bedrock VPC or
// PrivateLink endpoint, a regional Vertex endpoint such as
// us-east5-aiplatform.googleapis.com, a Foundry resource) is still that
// provider; anything else, an AWS load balancer or an Azure VM included, is a
// gateway in front of it.
const OWN_HOSTS = {
  bedrock: /(^|\.)bedrock[a-z-]*\..*amazonaws\.com(\.cn)?$/,
  vertex: /(^|[.-])aiplatform\.googleapis\.com$/,
  foundry: /\.(services\.ai|openai|cognitiveservices)\.azure\.com$/,
}

function viaGateway(url: string | undefined, own: RegExp): boolean {
  if (!url) return false
  try {
    return !own.test(new URL(url).hostname)
  } catch {
    return true
  }
}

// The provider and TTL variables, read once for applyForcedTtl and detect.
async function readProviderEnv($: EngineInterface): Promise<ProviderEnv> {
  const [apiKey, authToken, bedrock, vertex, foundry, baseUrl, bedrockUrl, vertexUrl, foundryUrl, mainEnv, subEnv, enable1h, force5m] =
    await Promise.all([
      $.env.get('ANTHROPIC_API_KEY'),
      $.env.get('ANTHROPIC_AUTH_TOKEN'),
      $.env.get('CLAUDE_CODE_USE_BEDROCK'),
      $.env.get('CLAUDE_CODE_USE_VERTEX'),
      $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
      $.env.get('ANTHROPIC_BASE_URL'),
      $.env.get('ANTHROPIC_BEDROCK_BASE_URL'),
      $.env.get('ANTHROPIC_VERTEX_BASE_URL'),
      $.env.get('ANTHROPIC_FOUNDRY_BASE_URL'),
      $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL'),
      $.env.get('ENABLE_PROMPT_CACHING_1H'),
      $.env.get('FORCE_PROMPT_CACHING_5M'),
    ])
  let provider: Provider
  if (truthy(bedrock)) provider = viaGateway(bedrockUrl, OWN_HOSTS.bedrock) ? 'gateway' : 'bedrock'
  else if (truthy(vertex)) provider = viaGateway(vertexUrl, OWN_HOSTS.vertex) ? 'gateway' : 'vertex'
  else if (truthy(foundry)) provider = viaGateway(foundryUrl, OWN_HOSTS.foundry) ? 'gateway' : 'foundry'
  else if (baseUrl) provider = 'gateway'
  else if (apiKey || authToken) provider = 'api-key'
  else provider = 'subscription'
  return { provider, force5m: truthy(force5m), enable1h: truthy(enable1h), mainEnv, subEnv }
}

// A conversation that already holds a request was built in the current TTL
// mode (a resumed or forked session, the mod enabled mid-session), and
// switching would miss every entry still warm. A pending first prompt is
// fine: only an answer means a request was made. When the transcript can't
// be read, assume it holds requests: a rewrite costs more than a 5m session.
async function hasRequests($: EngineInterface): Promise<boolean> {
  try {
    // Most sessions start empty: no need to load a transcript then.
    if ((await $.session.turns()) === 0) return false
    return (await $.session.messages()).some((m) => m.role === 'assistant')
  } catch {
    return true
  }
}

// Whether the user chose a TTL themselves, for either bucket.
function userChoseTtl(env: ProviderEnv, settings: CacheSettings | undefined): boolean {
  return !!(asTtl(env.mainEnv) || asTtl(env.subEnv) || asTtl(settings?.promptCacheTtl) || asTtl(settings?.subagentPromptCacheTtl))
}

// The TTL forceTtl asks for in this environment, or undefined to leave it alone.
function wantedTtl(env: ProviderEnv, settings: CacheSettings | undefined): Ttl | undefined {
  const choice = S.o.forceTtl
  if (choice !== 'auto') return choice === 'off' ? undefined : choice
  // A TTL the user chose (the ttl option, the environment, settings) stands.
  if (S.o.ttl !== 'detect' || userChoseTtl(env, settings)) return undefined
  // A subscription's default is already 1h; through a gateway the ttl field
  // and the anthropic-beta header may not be forwarded. Leave both alone.
  return env.provider === 'subscription' || env.provider === 'gateway' ? undefined : '1h'
}

// The TTL this mod set for a conversation in an earlier session, so a resumed
// one is sent in the mode its entries were written in. One key per
// conversation: concurrent sessions never overwrite each other's.
async function recordedTtl($: EngineInterface, id: string): Promise<Ttl | undefined> {
  try {
    const r = (await $.store.get(RECORD_PREFIX + id)) as { ttl?: unknown; at?: number } | undefined
    return r && (await $.clock.now()) - (r.at ?? 0) < RECORD_MS ? asTtl(r.ttl) : undefined
  } catch {
    return undefined
  }
}

// Records the forced TTL for the conversation running now, once per
// conversation (a /clear or /resume starts another); a failed write is tried
// again at the next turn's end.
async function recordForcedTtl($: EngineInterface): Promise<void> {
  if (!S.forcedTtl || !S.recordPending) return
  S.recordPending = false
  try {
    const [id, now] = await Promise.all([$.session.id(), $.clock.now()])
    await $.store.set(RECORD_PREFIX + id, { ttl: S.forcedTtl, at: now })
    await pruneRecords($, now)
  } catch (err) {
    S.recordPending = true
    throw err
  }
}

// Drops expired records, at most once a day: it reads every one.
async function pruneRecords($: EngineInterface, now: number): Promise<void> {
  const last = (await $.store.get(PRUNED_KEY)) as number | undefined
  if (last !== undefined && now - last < PRUNE_MS) return
  await $.store.set(PRUNED_KEY, now)
  for (const key of await $.store.keys()) {
    if (!key.startsWith(RECORD_PREFIX)) continue
    const r = (await $.store.get(key)) as { at?: number } | undefined
    if (now - (r?.at ?? 0) >= RECORD_MS) await $.store.delete(key)
  }
}

// Errors and denials alike come back as the reason, or ''. A hook's own deny
// rejects the call, where the engine's hold resolves with it.
async function denied(p: Promise<{ deny?: string } | void>): Promise<string> {
  try {
    return (await p)?.deny ?? ''
  } catch (err) {
    return String(err)
  }
}

// Sets both TTL variables, or neither: when the second write is refused the
// first is put back, so the buckets are never left apart. Resolves why not, or ''.
async function setTtls($: EngineInterface, want: Ttl, mainBefore: string | undefined): Promise<string> {
  const a = await denied($.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', want))
  if (a) return a
  const b = await denied($.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', want))
  if (b) await denied($.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', mainBefore))
  return b
}

// Set the session's TTL ourselves, so warming doesn't depend on the user's
// environment. Measured: Claude Code reads CLAUDE_CODE_PROMPT_CACHE_TTL per
// request, and a value set in session.start governs the first request on.
// Both buckets are set together (a fork in the other TTL mode rewrites the
// conversation), once, before this process sends any request. A conversation
// this mod ran before gets the TTL on record for it; one that holds requests
// from before is left alone, since a mode change over live entries costs one
// full rewrite. `env` is updated to what was set, for detect.
async function applyForcedTtl($: EngineInterface, env: ProviderEnv, settings: CacheSettings | undefined, model: string): Promise<void> {
  const target = await forceTarget($, env, settings, model)
  if (!target) return
  const { want, recorded } = target
  if (env.mainEnv === want && env.subEnv === want) {
    S.forcedTtl = want // already in force
    S.recordPending = true
    return
  }
  // A conversation on record was sent in that TTL before. A plugin enabled
  // partway through a session on one is the case this can't tell apart: the
  // process may have written entries in another mode since.
  if (!recorded && (await hasRequests($))) {
    $.ui.log(`cache TTL left at ${env.mainEnv ?? 'the default'}: this conversation already has requests; the ${want} TTL applies to the next new session`)
    return
  }
  const refused = await setTtls($, want, env.mainEnv)
  if (refused) {
    $.ui.log(`could not set the cache TTL: ${refused}`)
    return
  }
  env.mainEnv = env.subEnv = want
  S.forcedTtl = want
  S.recordPending = true
  if (recorded && recorded !== want) {
    $.ui.log(`cache TTL set to ${want} as forceTtl says; this conversation ran at ${recorded} before, so its next request rewrites the prefix once`)
  } else if (S.o.verbose) {
    $.ui.log(`cache TTL set to ${want} for this session (main conversation and forks)${recorded ? ', as on record for this conversation' : ''}`)
  }
}

// The TTL to force, or undefined to leave the environment alone: what
// forceTtl asks for here (a TTL the user chose, a gateway and a subscription
// are left alone), and the TTL on record for this conversation, if any. Under
// auto the record wins: it is the mode the conversation's entries are in. An
// explicit 1h or 5m wins over it.
async function forceTarget(
  $: EngineInterface,
  env: ProviderEnv,
  settings: CacheSettings | undefined,
  model: string,
): Promise<{ want: Ttl; recorded?: Ttl } | undefined> {
  if (env.force5m) {
    if (S.o.verbose) $.ui.log('not setting the cache TTL: FORCE_PROMPT_CACHING_5M is set')
    return undefined
  }
  const wanted = wantedTtl(env, settings)
  if (!wanted) return undefined
  const recorded = await recordedTtl($, await $.session.id().catch(() => ''))
  const want = S.o.forceTtl === 'auto' ? (recorded ?? wanted) : wanted
  if (want === '1h' && isBedrock5mOnly(env.provider, model)) {
    $.ui.log('not setting a 1h cache TTL: this model supports the 5-minute TTL only on Bedrock')
    return undefined
  }
  return { want, recorded }
}

type CacheSettings = { promptCacheTtl?: unknown; subagentPromptCacheTtl?: unknown; apiKeyHelper?: unknown }

// Mirrors Claude Code's own precedence for the main conversation's TTL, and
// reads the subagent bucket a ping is sent in.
function detect(env: ProviderEnv, settings: CacheSettings | undefined): void {
  S.provider = env.provider
  ;[S.ttlBase, S.ttlBaseSource] = mainTtlFrom(env, asTtl(settings?.promptCacheTtl))
  ;[S.forkTtl, S.forkTtlSource] = forkTtlFrom(env, asTtl(settings?.subagentPromptCacheTtl))
}

function mainTtlFrom(env: ProviderEnv, settingTtl: Ttl | undefined): [Ttl, string] {
  const mainEnv = asTtl(env.mainEnv)
  const option = S.o.ttl
  if (env.force5m) return ['5m', 'FORCE_PROMPT_CACHING_5M']
  if (S.forcedTtl && mainEnv === S.forcedTtl) return [S.forcedTtl, 'set by cache-warm']
  if (option === '5m' || option === '1h') return [option, 'plugin config']
  if (mainEnv) return [mainEnv, 'CLAUDE_CODE_PROMPT_CACHE_TTL']
  if (settingTtl) return [settingTtl, 'promptCacheTtl setting']
  if (env.enable1h) return ['1h', 'ENABLE_PROMPT_CACHING_1H']
  if (S.provider === 'subscription') return ['1h', 'subscription default']
  return ['5m', `${S.provider} default`]
}

// With nothing set for the subagent bucket a fork inherits the main
// conversation's TTL (measured): ''. ENABLE_PROMPT_CACHING_1H may reach forks
// too (not measured): where it would differ from the main TTL it is treated as
// explicit, so the mismatch is refused rather than paid for.
function forkTtlFrom(env: ProviderEnv, subSetting: Ttl | undefined): ['' | Ttl, string] {
  const subEnv = asTtl(env.subEnv)
  if (env.force5m) return ['', '']
  if (subEnv) return [subEnv, S.forcedTtl === subEnv ? 'set by cache-warm' : 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL']
  if (subSetting) return [subSetting, 'subagentPromptCacheTtl setting']
  if (env.enable1h) return ['1h', 'ENABLE_PROMPT_CACHING_1H']
  return ['', '']
}

// Reads the session's provider, model and TTL, setting the TTL first when the
// mod should. A reload keeps what the first load did: the conversation may
// already hold requests, and the environment it set is still in force.
async function configure($: EngineInterface, kept: CacheView | null, k: KeptState | null): Promise<void> {
  const [model, usage, env, settings] = await Promise.all([
    $.session.model().catch(() => ''),
    usageNow($),
    readProviderEnv($),
    $.settings.read().catch(() => undefined) as Promise<CacheSettings | undefined>,
  ])
  // An API key from apiKeyHelper is no subscription, whatever the environment says.
  if (env.provider === 'subscription' && settings?.apiKeyHelper) env.provider = 'api-key'
  S.model = kept?.model || model
  S.sessionModel = model
  if (k) S.forcedTtl = k.forcedTtl
  else if (!kept) {
    try {
      await applyForcedTtl($, env, settings, model)
    } catch (err) {
      $.ui.log(`could not set the cache TTL: ${String(err)}`)
    }
  }
  detect(env, settings)
  noteRateLimits(usage?.rateLimits ?? [])
}

// After a hot reload: the session totals, and the kept state (overrides,
// holds, guard counters, the idle period as it stood, a learned TTL). Returns
// whether it was warming, which the reload's timer cancel interrupted. A
// reload mid-turn may miss the turn's end: turnRunning stays false, and
// warming waits for the next turn.complete rather than an end that never comes.
function restore(kept: CacheView | null, k: KeptState | null): boolean {
  if (kept) {
    Object.assign(S, pick(kept, TOTALS))
    S.rttMax = kept.rttMs
    S.rttEma = kept.rttMs ? kept.rttMs / 1.5 : 0
    S.prefixTokens = kept.prefixTokens
    S.lastRequestAt = kept.lastRequestAt
  }
  // A view from 0.6, before the kept state: its pause is all it holds of it.
  if (!k) {
    S.paused = kept?.paused ?? ''
    return false
  }
  Object.assign(S, pick(k, KEPT))
  S.keptJson = JSON.stringify(k)
  S.recordPending = !!S.forcedTtl // a write too many beats a record missed
  if (k.observed) {
    ;[S.ttlBase, S.ttlBaseSource] = [k.observed.ttl, k.observed.source]
    settleTtl()
  }
  return kept?.phase === 'warming' && !!S.lastRequestAt
}

// ---- the idle period ------------------------------------------------------------

// One idle period runs from a turn's last request to the next turn's start.
// Its counters are reset only here.
function beginIdlePeriod(start: number): void {
  S.idleGen += 1
  S.idleStartAt = start
  S.idleTtl = S.lastRequestTtl
  S.idlePings = S.idleAutoPings = S.idleWrites = S.idleErrors = 0
  S.idleSpent = S.idleSpentPct = 0
  S.avgPingUsd = undefined
  S.retryBackoffMs = 0
  S.idleNote = ''
}

function endIdlePeriod(): void {
  clearWarming()
  beginIdlePeriod(0)
}

function clearWarming(): void {
  S.timer?.cancel()
  S.timer = undefined
  S.warming = false
  S.pingWanted = false
}

// A /clear or a resume: the process goes on with another conversation, in
// the TTL the process has; it goes on record once it has a turn.
function resetConversation(): void {
  endIdlePeriod()
  S.recordPending = true
  S.pendingReturn = undefined
  S.turnRunning = false
  S.lastRequestAt = 0
  S.prefixTokens = 0
  S.coldPrefix = ''
  S.gapPings = 0
  S.mainWrites = 0
  S.sessionModel = ''
}

// The next request sends a prefix nothing has cached (after a compaction or a
// model switch): there is nothing to keep warm, and the rewrite it brings is
// no verdict on pings.
async function markCold($: EngineInterface, cause: ColdPrefix, why: string, prefixTokens?: number): Promise<void> {
  if (S.warming) $.ui.log(`stopped: ${why}`)
  endIdlePeriod()
  S.pendingReturn = undefined
  S.coldPrefix = cause
  S.idleNote = why
  // Without the compaction's own figure, the context window's is the best guess.
  S.prefixTokens = prefixTokens ?? (await usageNow($))?.context.tokens ?? S.prefixTokens
  await publish($)
}

// The first request after an idle period longer than the TTL says whether its
// pings paid off. Two idle periods in a row that spent on pings and came back
// cold pause automatic warming: a pattern of leaving for longer than the
// break-even point should not keep costing. Only pings auto mode's timer sent
// count: a duration chosen in manual mode, or a ping sent by hand, is no such
// pattern.
function settleReturn($: EngineInterface, r: PendingReturn, u: ModelUsage): void {
  if (classify(u, r.prefix) === 'hit') {
    S.saved += r.saving
    S.returnsWarm += 1
    S.consecutiveLosses = 0
    if (S.o.verbose) $.ui.log(`warm return: saved ${fmtUsd(r.saving)}`)
    return
  }
  S.returnsCold += 1
  $.ui.log(`cold return despite ${r.pings} pings: the API rewrote ${fmtK(u.cache_creation_input_tokens)} tokens`)
  if (r.autoPings === 0) return
  S.consecutiveLosses += 1
  if (S.consecutiveLosses >= 2 && !S.paused) {
    S.paused = `${S.consecutiveLosses} idle periods spent on pings without a warm return`
    $.ui.log(`paused: ${S.paused}. Run /cachewarm on to resume, or set a shorter stopFraction.`)
  }
}

// ---- warming ----------------------------------------------------------------------

// Lets a promise run with nobody waiting on it, so a failure (a state write
// during an unload) never surfaces as an unhandled rejection.
function quiet(p: Promise<unknown>): void {
  p.catch(() => {})
}

// `breakEven`: warming reached its planned end (the break-even point, or the
// manual duration), the one stop endAction 'compact' acts on.
async function stopWarming($: EngineInterface, why: string, { breakEven = false } = {}): Promise<void> {
  const wasWarming = S.warming
  clearWarming()
  if (!wasWarming) return
  S.idleNote = why
  $.ui.log(`stopped: ${why} · ${S.idlePings} pings, ${fmtUsd(S.idleSpent)}`)
  await publish($)
  if (!breakEven || S.o.endAction !== 'compact' || S.idlePings === 0 || S.turnRunning) return
  // Only while the cache is still warm: a compaction over a lapsed one reads
  // the whole prefix uncached and writes it again.
  if (arrivalAt(await $.clock.now()) >= expiresAt()) return
  $.ui.log('compacting while the cache is still warm, so the rebuild is small')
  S.compacting = 'compacted at the break-even point'
  try {
    // The session.compact hook marks the new prefix cold; this covers an
    // engine that does not raise it for a plugin's own call.
    const r = await $.session.compact({ instructions: 'cache-warm: compacting at the break-even point.' })
    if (r.messages && !S.coldPrefix) await markCold($, 'compacted', S.compacting, r.tokensAfter)
  } catch (err) {
    $.ui.log(`compact failed: ${String(err)}`)
  } finally {
    S.compacting = ''
  }
}

// `breakEven`: whether a next ping past the planned stop is the plan's end
// (endAction acts on it), or only a change of plan, as a new interval is.
function schedulePing($: EngineInterface, now: number, breakEven = true): void {
  S.timer?.cancel()
  S.nextPingAt = Math.max(now + 1000, S.lastRequestAt + intervalMs())
  if (S.nextPingAt > S.stopAt) {
    quiet(stopWarming($, mode() === 'auto' ? 'break-even reached; letting the cache lapse' : 'duration reached', { breakEven }))
    return
  }
  S.timer = $.clock.after(S.nextPingAt - now, () => {
    quiet(ping($))
  })
  quiet(publish($, now))
}

// Pauses automatic warming until /cachewarm on, logged once; returns the
// reason as whyNotWarm reports it.
function pause($: EngineInterface, why: string): string {
  if (S.paused !== why) $.ui.log(`paused: ${why}`)
  S.paused = why
  return `paused: ${why}`
}

// Pauses and stops this idle period's warming.
async function pauseWarming($: EngineInterface, why: string): Promise<void> {
  S.paused = why
  await stopWarming($, `paused: ${why}`)
}

// The holds /cachewarm on lifts, or ''. Reads state only.
function heldBy(): string {
  if (S.paused) return `paused: ${S.paused}`
  // The main thread itself keeps rewriting a prefix that should have been
  // warm: caching isn't working on this provider or model, so pings would
  // write too. Leave it alone until a real turn reads the cache again.
  if (S.mainWrites >= 2) return 'the last two requests rewrote the prefix; caching looks unhealthy here'
  return ''
}

// Why this idle period can't be warmed now, or ''. `force` (/cachewarm on)
// passes the holds; never an expired cache, a running turn, or a TTL
// mismatch, which is configuration: every ping would rewrite the conversation.
async function whyNotWarm($: EngineInterface, now: number, force: boolean): Promise<string> {
  if (S.turnRunning) return 'a turn is running'
  if (mode() === 'off') return 'mode off'
  if (S.coldPrefix) return S.idleNote || 'nothing is cached for the next request'
  if (!S.lastRequestAt) return 'no turn yet'
  if (now >= expiresAt() - marginMs()) return 'the cache has expired'
  // Configuration, checked each time rather than paused on: it clears itself
  // when the TTLs agree again.
  const mismatch = ttlMismatch()
  if (mismatch) return `held: ${mismatch}`
  const moved = ttlMoved()
  if (moved) return moved
  const held = force ? '' : heldBy()
  if (held) return held
  if (!force && tooSlowForTtl()) {
    return pause($, `ping round-trips up to ${Math.round(S.rttMax / 1000)}s are too slow for a ${liveTtl()} cache; use promptCacheTtl 1h`)
  }
  return whyTooSmall($)
}

// Below the model's minimum cacheable prefix there is nothing to keep warm.
async function whyTooSmall($: EngineInterface): Promise<string> {
  const minimum = minCacheable(S.model)
  if (S.prefixTokens >= minimum) return ''
  S.prefixTokens = (await usageNow($))?.context.tokens ?? S.prefixTokens
  if (S.turnRunning) return 'a turn is running' // it started while usage was read
  return S.prefixTokens < minimum ? `the prefix is under this model's ${fmtK(minimum)}-token cache minimum` : ''
}

async function refuseWarming($: EngineInterface, why: string): Promise<string> {
  S.idleNote = why
  if (S.o.verbose) $.ui.log(`not warming: ${why}`)
  await publish($)
  return why
}

// Starts warming this idle period; resolves '' when it did, else why not.
async function startWarming($: EngineInterface, now: number, force = false): Promise<string> {
  if (S.warming) return ''
  const refused = await whyNotWarm($, now, force)
  if (S.warming) return '' // another start won the race while that was read
  if (refused) return refuseWarming($, refused)
  S.warming = true
  S.idleNote = ''
  S.stopAt = planStopAt(periodStart())
  if (S.stopAt <= now) {
    S.warming = false
    return refuseWarming($, `this idle period is past its ${mode() === 'auto' ? 'break-even point' : 'manual duration'}`)
  }
  // A plan that ends before its first ping is no end reached: nothing compacts.
  schedulePing($, now, false)
  // The first ping already falls past the planned end: schedulePing stopped.
  if (!S.warming) return S.idleNote
  if (S.o.verbose) {
    const e = econNow()
    $.ui.log(
      `warming on: ${liveTtl()} entry via ${S.provider}, ${fmtK(S.prefixTokens)} tokens on ${S.model || 'unknown model'}; ` +
        `a ping every ${fmtMin(intervalMs())}; ping ≈ ${fmtUsd(e.ping)}, warm return saves ${fmtUsd(e.saving)}, ` +
        `break-even ${e.pings.toFixed(1)} pings; stops ${fmtClock(S.stopAt)}`,
    )
  }
  return ''
}

function fiveHour(s?: SessionUsage): number | undefined {
  return s?.rateLimits.find((l) => l.kind === 'five_hour')?.percentUsed
}

// What a ping cost. The session's cost ledger is exact while nothing else
// spent during the ping; a background agent or a turn that started meanwhile
// would be charged to it too, and a ledger read before it booked the fork
// would show too little, so the ledger (and the five-hour points with it) is
// taken only while it agrees with the token count to within 2x either way. A
// fork with no usage never reached the API: nothing agrees with that but $0.
function pingCost(u: ModelUsage, ttl: Ttl, before?: SessionUsage, after?: SessionUsage): { usd: number; pct: number } {
  const estimate = usd(u, priceNow(), ttl)
  const ledger = before?.cost && after?.cost ? after.cost.usd - before.cost.usd : 0
  const agrees = ledger >= 0.5 * estimate && ledger <= 2 * estimate
  const p0 = fiveHour(before)
  const p1 = fiveHour(after)
  return {
    usd: agrees ? ledger : estimate,
    pct: (ledger <= 0 || agrees) && p0 !== undefined && p1 !== undefined && p1 >= p0 ? p1 - p0 : 0,
  }
}

type PingOptions = { manual?: boolean; force?: boolean }

// One ping; resolves what happened, in a line. A timer's ping runs only while
// warming; /cachewarm ping runs one any time (`manual`), and past a cache it
// believes cold with `force`.
async function ping($: EngineInterface, opts: PingOptions = {}): Promise<string> {
  if (S.turnRunning) return 'a turn is running; it refreshes the cache itself.'
  if (!opts.manual && !S.warming) return 'not warming.'
  if (S.pinging) {
    // Another ping holds the line (a command's, or a slow one from an idle
    // period that has ended): a timer's ping is scheduled again when it lands.
    if (!opts.manual) S.pingWanted = true
    return 'a ping is already in flight.'
  }
  // Before any await, so a timer and a command never both send.
  S.pinging = !opts.manual && mode() === 'auto' ? 'auto' : 'other'
  try {
    return await pingOnce($, opts)
  } catch (err) {
    // The engine refused to send it (a blocked model, another plugin's deny):
    // trying again changes nothing.
    const why = `ping failed: ${String(err)}`
    await stopWarming($, why).catch(() => {})
    return why
  } finally {
    S.pinging = ''
    if (S.pingWanted && S.warming) {
      S.pingWanted = false
      quiet($.clock.now().then((now) => schedulePing($, now)))
    }
  }
}

// Everything before the fork awaited: a turn, /cachewarm off or stop, or a
// /clear may have come in meanwhile.
function stillWanted(gen: number, opts: PingOptions): boolean {
  return !S.turnRunning && gen === S.idleGen && (opts.manual || S.warming)
}

async function pingOnce($: EngineInterface, opts: PingOptions): Promise<string> {
  const gen = S.idleGen
  const firstPing = S.idlePings === 0
  const prevRequestAt = S.lastRequestAt
  const liveFor = TTL_MS[liveTtl()]
  const refused = opts.force ? '' : await preflight($)
  if (refused) return refused
  // A forced ping may go out after a model switch: the cache it writes is
  // that model's, and preflight then judges later pings against it.
  const model = opts.force ? await $.session.model().catch(() => S.sessionModel) : S.sessionModel

  const before = await usageNow($)
  const t0 = await $.clock.now()
  if (!stillWanted(gen, opts)) return 'not sent: warming stopped before the ping went out.'
  // Never change CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL from here: measured on
  // the API, a fork sent after a mid-process change of that variable missed
  // the entire prefix and rewrote it. The variable is only safe set at startup.
  const sentTtl = refreshTtl()
  const r = await $.model.fork({ prompt: PING_PROMPT })
  const t1 = await $.clock.now()
  if (!('usage' in r)) {
    await stopWarming($, 'nothing to fork yet (no completed turn in this conversation)')
    return 'nothing to fork yet (no completed turn in this conversation).'
  }
  const after = await usageNow($)
  const u = r.usage
  const outcome = classify(u, S.prefixTokens)
  const cost = pingCost(u, sentTtl, before, after)
  if (after) noteRateLimits(after.rateLimits)
  if (!chargePing(r, cost, gen)) {
    await publish($)
    return `pinged as the idle period ended: ${fmtUsd(cost.usd)}.`
  }
  // A read refreshed the entry from this request's start; a write made a new
  // one from there, at full cost.
  if (outcome !== 'none') [S.lastRequestAt, S.coldPrefix, S.sessionModel] = [t0, '', model]

  if (!r.isAnswered && r.reason === 'aborted') return pingCutOff($, t1)
  if (!r.isAnswered && r.reason === 'api-error') return pingRefused($, r, t1)
  return judgePing($, opts, { u, outcome, usd: cost.usd, t0, t1, firstPing, sentWithin: t0 - (prevRequestAt || t0), liveFor, sentTtl })
}

async function usageNow($: EngineInterface): Promise<SessionUsage | undefined> {
  try {
    return await $.session.usage()
  } catch {
    return undefined
  }
}

// Guard 1 and its kin: a ping that would rewrite rather than read is not sent.
// Resolves why not, or ''.
async function preflight($: EngineInterface): Promise<string> {
  // Never ping a cache that may already be gone. The TTL runs from the
  // request's start at the API, and the body takes time to upload, so if the
  // expected arrival is past expiry the ping would be a full rewrite.
  if (arrivalAt(await $.clock.now()) >= expiresAt()) {
    const why = `the ping window was missed (cache expired ${fmtClock(expiresAt())}; a sleep, a stall or a slow link); not rewriting it`
    await stopWarming($, why)
    return `${why}.`
  }
  const moved = ttlMoved()
  if (moved) {
    await stopWarming($, moved)
    return `${moved}.`
  }
  // A model switched while idle has no cache: the fork would pay for the whole
  // prefix at the write rate.
  const model = await $.session.model().catch(() => S.sessionModel)
  if (S.sessionModel && model !== S.sessionModel) {
    await markCold($, 'model', `the model changed to ${model}; its cache starts with the next turn`)
    return `${S.idleNote}.`
  }
  return ''
}

// Books a ping's cost: in the session always, and in this idle period while it
// is still the one the ping was sent in, which it returns. A failed fork still
// bills the requests before the failure; one with no usage never reached the API.
function chargePing(r: ModelCompleteResult, cost: { usd: number; pct: number }, gen: number): boolean {
  const counts = r.isAnswered || r.reason === 'empty-reply' || cost.usd > 0
  if (counts) {
    S.pings += 1
    S.spent += cost.usd
    S.spentPct += cost.pct
    S.lastPingUsd = cost.usd
  }
  // The idle period ended while the ping was in flight (a turn started, a
  // /clear): its cost counts in the session, nothing else does.
  if (gen !== S.idleGen || S.turnRunning) return false
  if (counts) {
    S.idlePings += 1
    if (S.pinging === 'auto') S.idleAutoPings += 1
    S.idleSpent += cost.usd
    S.idleSpentPct += cost.pct
    S.avgPingUsd = S.idleSpent / S.idlePings
  }
  return true
}

// Escape on the turn that awaited the fork, or the plugin unloading: no
// verdict on the cache. A timer's ping tries again (an unloading module's
// timers are gone anyway, and its last published phase stays 'warming' for
// the next load to pick up); three in one idle period stop.
async function pingCutOff($: EngineInterface, t1: number): Promise<string> {
  S.idleErrors += 1
  if (S.idleErrors >= 3) await stopWarming($, 'three pings were cut off')
  else if (S.warming) schedulePing($, t1)
  return 'the ping was cut off before a reply.'
}

type AnsweredPing = {
  u: ModelUsage
  outcome: CacheOutcome
  usd: number
  t0: number
  t1: number
  firstPing: boolean
  sentWithin: number // how long after the last refresh the ping went out
  liveFor: number // what that refresh bought
  sentTtl: Ttl // the TTL mode the fork went out in
}

// A ping's line in the transcript: every miss, and each hit when verbose.
function logPing($: EngineInterface, p: AnsweredPing, rtt: number): void {
  const { u, outcome } = p
  if (!S.o.verbose && outcome === 'hit') return
  $.ui.log(
    `ping #${S.idlePings} ${outcome}: read ${fmtK(u.cache_read_input_tokens)} · wrote ${fmtK(u.cache_creation_input_tokens)} · ` +
      `uncached ${fmtK(u.input_tokens)} · out ${u.output_tokens} · ${fmtUsd(p.usd)} · ${(rtt / 1000).toFixed(1)}s`,
  )
}

// An answered ping: learn its latency, log it, judge what it did to the cache,
// and schedule the next one.
async function judgePing($: EngineInterface, opts: PingOptions, p: AnsweredPing): Promise<string> {
  const { u, outcome } = p
  S.retryBackoffMs = 0
  // The round-trip includes generating the reply, which the TTL does not wait
  // for (only the request's arrival counts), and nothing here times the two
  // apart: discount output at a fast 100 tokens/s, never below a quarter.
  // A ping sent by hand (a forced rewrite above all) says nothing about the link.
  const rtt = p.t1 - p.t0
  if (!opts.manual) noteRtt(Math.max(rtt / 4, rtt - u.output_tokens * 10))
  const summary =
    `${outcome === 'hit' ? 'cache hit' : `MISS (${outcome})`}: read ${fmtK(u.cache_read_input_tokens)} · ` +
    `wrote ${fmtK(u.cache_creation_input_tokens)} · ${fmtUsd(p.usd)}`
  logPing($, p, rtt)
  // A first ping that read breaks Bedrock's row of first-ping rewrites.
  if (p.firstPing && (outcome === 'hit' || outcome === 'partial')) S.firstPingWrites = 0
  if (outcome !== 'hit') {
    S.misses += 1
    if (outcome === 'write') {
      S.writes += 1
      S.idleWrites += 1
    }
    // A forced ping went out over a cache believed cold: its rewrite is the
    // expected outcome, not a diagnosis.
    const miss = { firstPing: p.firstPing, fresh: p.sentWithin < p.liveFor - marginMs(), rtt, manual: !!opts.manual }
    if (!opts.force && (await diagnoseMiss($, outcome, miss))) return `pinged: ${summary}.`
  }
  // A forced write is a new entry, in the mode the fork went out in: its idle
  // period starts over, the write paid for and done with.
  if (opts.force && outcome === 'write') {
    beginIdlePeriod(p.t0)
    S.idleTtl = p.sentTtl
  }
  if (await passedBreakEven($)) return `pinged: ${summary}.`
  if (S.warming) schedulePing($, p.t1)
  else await publish($)
  return `pinged: ${summary}.`
}

// Guard 4: a ping that costs more than half of a rewrite (a big last-turn
// delta rewritten each time) can never break even within the interval it
// buys, in any mode: a stop, not the plan's end. And in auto mode, once this
// idle period has spent what a cold rewrite would cost, pinging can no longer
// come out ahead, whatever the plan said: the planned end. Resolves true when
// warming stopped.
async function passedBreakEven($: EngineInterface): Promise<boolean> {
  if (!S.warming) return false
  const e = econNow()
  if (S.avgPingUsd !== undefined && S.avgPingUsd >= 0.5 * e.saving) {
    await stopWarming($, `a ping costs ${fmtUsd(S.avgPingUsd)} against a ${fmtUsd(e.saving)} rewrite; not worth it here`)
    return true
  }
  if (mode() !== 'auto') return false
  if (S.idleSpent >= e.saving * Math.max(0.05, S.o.stopFraction)) {
    await stopWarming($, `spent ${fmtUsd(S.idleSpent)} this idle period, the cost of a cold rewrite; letting it lapse`, { breakEven: true })
    return true
  }
  // Re-plan with the measured ping cost: the break-even point moves if pings
  // cost more (thinking tokens) or less than the estimate.
  S.stopAt = planStopAt(periodStart())
  return false
}

// Guard 2: a refused ping. Rate limits, overload, 5xx and errors of no named
// kind retry with backoff, but only while a retry can still land inside the
// window. An auth failure (a token that refreshes) ends this idle period's
// warming; anything else (a bad request, billing) would fail the same way in
// every idle period, so it pauses.
async function pingRefused($: EngineInterface, r: { status: number | null; error: string }, t1: number): Promise<string> {
  S.idleErrors += 1
  S.misses += 1
  const what = `ping failed: ${r.error} (${r.status ?? 'no response'})`
  $.ui.log(what)
  const retryable = ['rate_limit', 'overloaded', 'server_error', 'unknown'].includes(r.error) || r.status === null
  if (r.error === 'authentication_failed') {
    await stopWarming($, 'the API refused a ping: authentication_failed')
    return `${what}.`
  }
  if (!retryable) {
    await pauseWarming($, `the API refused a ping: ${r.error}`)
    return `${what}.`
  }
  if (S.idleErrors >= 3) {
    await stopWarming($, 'three failed pings')
    return `${what}.`
  }
  S.retryBackoffMs = S.retryBackoffMs ? Math.min(S.retryBackoffMs * 2, 120_000) : 15_000
  const retryAt = t1 + S.retryBackoffMs
  if (arrivalAt(retryAt) >= expiresAt() - 5_000) {
    await stopWarming($, 'the API kept refusing pings until the cache expired')
    return `${what}.`
  }
  if (S.warming) {
    S.timer?.cancel()
    S.nextPingAt = retryAt
    S.timer = $.clock.after(S.retryBackoffMs, () => {
      quiet(ping($))
    })
    await publish($)
  }
  return `${what}.`
}

type Miss = { firstPing: boolean; fresh: boolean; rtt: number; manual: boolean }

// Guard 3: a ping that wrote or missed is a loss event. Work out why and stop
// before it can happen twice. Resolves true when warming stopped.
async function diagnoseMiss($: EngineInterface, outcome: CacheOutcome, m: Miss): Promise<boolean> {
  if (outcome === 'none') {
    // The ping read and wrote (almost) nothing of the prefix: it isn't cached
    // here, and nothing was refreshed, so another ping would only pay again.
    const why = 'pings are not cached on this provider or model (a ping read and wrote almost nothing of the prefix)'
    if (S.prefixTokens >= minCacheable(S.model)) await pauseWarming($, why)
    else await stopWarming($, why)
    return true
  }
  if (m.firstPing && m.fresh && outcome === 'write') {
    // The cache was certainly alive and the fork still didn't read it: the
    // fork's request differs from the main thread's (a gateway rewriting
    // cache_control, a provider quirk). Every ping would write, so pause.
    // Bedrock's cross-region routing can write once under load, so there it
    // takes two pinged idle periods in a row before the session is paused.
    S.firstPingWrites += 1
    if (S.provider === 'bedrock' && S.firstPingWrites < 2) {
      await stopWarming($, 'the first ping rewrote a live cache (Bedrock cross-region load?); not pinging again this idle period')
      return true
    }
    await pauseWarming($, 'the first ping rewrote a live cache: the fork request differs from the main thread (gateway or provider)')
    return true
  }
  // Expired in flight: the link is slower than the margin allowed for. A
  // ping sent by hand near the edge says nothing about the link.
  if (!m.fresh && !m.manual && (await raiseMargin($, m.rtt))) return true
  if (S.idleWrites >= 2) {
    await pauseWarming($, 'two pings in one idle period rewrote the cache')
    return true
  }
  if (outcome === 'partial' && S.o.verbose) {
    $.ui.log("partial read: the ping rewrote the last turn's delta; its cost is counted against the break-even")
  }
  return false
}

// Raises the ping margin to the latency just seen; resolves true when that
// leaves the TTL too short to warm.
async function raiseMargin($: EngineInterface, rtt: number): Promise<boolean> {
  noteRtt(Math.max(rtt, marginMs()))
  $.ui.log(`the cache expired before this ping arrived; ping margin raised to ${fmtCountdown(marginMs())}`)
  if (!tooSlowForTtl()) return false
  await pauseWarming($, `the connection is too slow for a ${liveTtl()} refresh (margin ${fmtCountdown(marginMs())}); use promptCacheTtl 1h`)
  return true
}

// /cachewarm on|auto|manual: switch mode, lift a pause, and warm this idle
// period when it can be.
async function resume($: EngineInterface, m: Mode, now: number): Promise<string> {
  S.overrideMode = m
  const resumed = S.paused
  S.paused = ''
  S.consecutiveLosses = S.mainWrites = S.firstPingWrites = 0
  const plan =
    `a ping every ${fmtMin(intervalMs())} (margin ${fmtCountdown(marginMs())}) ` +
    (m === 'auto' ? `until break-even × ${S.o.stopFraction}` : `for ${S.overrideDuration ?? S.o.durationMinutes} min`)
  const after = resumed ? ` Resumed after: ${resumed}.` : ''
  if (S.turnRunning) {
    S.forceNext = true
    return `cache-warm ${m}: ${plan}, from the end of this turn.${after}`
  }
  clearWarming() // re-plan the stop for the new mode
  const refused = await startWarming($, now, true)
  return `cache-warm ${m}: ${plan}.${refused ? ` Not warming this idle period: ${refused}.` : ''}${after}`
}

function calcText(): string {
  const p = priceNow()
  const N = S.prefixTokens || 100_000
  // A ping renews the TTL it is sent in, which is the main conversation's
  // unless the subagent bucket says otherwise (and then it rewrites).
  const rows = (['5m', '1h'] as Ttl[]).map((ttl) => {
    const isThis = ttl === S.ttl && ttl === refreshTtl()
    const e = economics(N, ttl, p, isThis ? S.avgPingUsd : undefined)
    const first = intervalFor(ttl)
    return (
      `${ttl} TTL: write ${WRITE_MULT[ttl]}x, read ${p.read}x → warm return saves ${fmtUsd(e.saving)}, ping ≈ ${fmtUsd(e.ping)}; ` +
      `a ping every ${fmtMin(first)}; break-even ${e.pings.toFixed(1)} pings = ${fmtMin(e.pings * first)}` +
      (isThis ? ' ◀ this session' : '')
    )
  })
  return (
    `model ${S.model || '?'} · ${S.provider} · entry TTL ${S.ttl} (${S.ttlSource}) · ping refresh ${refreshTtl()} (${refreshTtlSource()}) · prefix ${fmtK(N)} tokens` +
    (S.prefixTokens ? '' : ' (assumed; no turn yet)') +
    ` · $${p.input}/MTok base input${p.known ? '' : ' (model not in table, using $3)'}` +
    (S.provider === 'bedrock' && !S.o.inputPricePerMTok ? ' (Bedrock list ≈ Anthropic +10%; verify on the AWS pricing page)' : '') +
    (S.provider === 'gateway' && !S.o.inputPricePerMTok ? " (gateway: set inputPricePerMTok to your upstream's rate)" : '') +
    '\n' +
    rows.join('\n') +
    (S.ttl !== refreshTtl() ? `\nThis session's pings are sent in another TTL mode than the conversation: each one rewrites it.` : '') +
    `\nBreak-even time does not depend on prefix size: the saving and each ping both scale with it. ` +
    `Only the TTL, the model's read multiplier and the interval set it; warming stops at break-even × stopFraction (${S.o.stopFraction}).` +
    (S.ttl === '5m'
      ? `\nTip: forceTtl: "1h" (or promptCacheTtl and subagentPromptCacheTtl both "1h", set before the session starts) makes each ping buy an hour; ` +
        `the 1h write costs 0.75x extra only on each turn's new tokens.`
      : '')
  )
}

function statusText(now: number): string {
  const totals =
    `session: ${S.pings} pings, ${fmtUsd(S.spent)} spent${S.spentPct ? ` (${S.spentPct.toFixed(1)}% of the 5h window)` : ''}, ` +
    `${fmtUsd(S.saved)} saved, net ${fmtUsd(S.saved - S.spent)}; ` +
    `${S.returnsWarm} warm return${S.returnsWarm === 1 ? '' : 's'}, ${S.returnsCold} cold, ${S.misses} misses`
  const head =
    `${S.provider} · entry TTL ${S.ttl} (${S.ttlSource}) · ping refresh ${refreshTtl()} (${refreshTtlSource()}) · model ${S.model || '?'} · prefix ${fmtK(S.prefixTokens)} tokens · ` +
    `ping margin ${fmtCountdown(marginMs())}${S.rttMax ? ` (slowest ping ${(S.rttMax / 1000).toFixed(1)}s)` : ''}` +
    (S.paused ? `\nPAUSED: ${S.paused} (/cachewarm on to resume)` : '') +
    (ttlMismatch() ? `\nHELD: ${ttlMismatch()}` : '') +
    (S.mainWrites >= 2 ? '\ncaching looks unhealthy: the last two requests rewrote the prefix' : '')
  const ph = phase(now)
  if (ph === 'none') return `cache-warm (mode ${mode()}) · ${head}\nno turn yet; warming starts when a turn completes.\n${totals}`
  if (!S.warming) return `cache-warm · ${head}\n${idleStateText(ph, now)}\n${totals}`
  const e = econNow()
  return (
    `warming · ${head}\n` +
    `cache expires in ${fmtCountdown(expiresAt() - now)}; next ping ${fmtClock(S.nextPingAt)} (${fmtCountdown(S.nextPingAt - now)}), ` +
    `then every ${fmtMin(intervalMs())}; stops ${fmtClock(S.stopAt)} (${mode()})\n` +
    `this idle period: ${S.idlePings} pings, ${fmtUsd(S.idleSpent)}${S.idleSpentPct ? ` / ${S.idleSpentPct.toFixed(1)}% of the 5h window` : ''}; ` +
    `last ping ${S.lastPingUsd === undefined ? '-' : fmtUsd(S.lastPingUsd)}; a warm return saves ${fmtUsd(e.saving)}; break-even ${e.pings.toFixed(1)} pings\n` +
    totals
  )
}

// The state line of /cachewarm status while not warming.
function idleStateText(ph: Phase, now: number): string {
  if (ph === 'turn') return 'turn in progress (every request refreshes the cache)'
  if (ph === 'warm') {
    return `warm, expires in ${fmtCountdown(expiresAt() - now)} (not warming: ${S.idleNote || `mode ${mode()}`})`
  }
  const p = priceNow()
  const e = econNow()
  return (
    `cold${S.coldPrefix && S.idleNote ? ` (${S.idleNote})` : ''}: the next turn rewrites ${fmtK(S.prefixTokens)} tokens ` +
    `(≈ ${fmtUsd(e.saving + (S.prefixTokens * p.input * p.read) / 1e6)})`
  )
}

type BandState = { color: 'success' | 'warning' | 'subtle' | 'claude'; text: string }

// The band's first line: the cache state and its countdowns.
function bandState(v: CacheView, narrow: boolean): BandState {
  const left = v.lastRequestAt + TTL_MS[v.liveTtl] - v.now
  switch (v.phase) {
    case 'none':
      return { color: 'subtle', text: 'waiting for the first turn' }
    case 'turn':
      return { color: 'claude', text: 'turn in progress · cache refreshing' }
    case 'warming':
      return {
        color: 'success',
        text:
          `warm · expires ${fmtCountdown(left)} · ping in ${fmtCountdown(v.nextPingAt - v.now)}` +
          (narrow ? '' : ` · stops ${fmtClock(v.stopAt)}${v.mode === 'auto' ? ' (break-even)' : ''} · margin ${fmtCountdown(v.marginMs)}`),
      }
    case 'warm':
      return { color: 'success', text: `warm · expires ${fmtCountdown(left)}${v.mode === 'off' ? ' · warming off' : ' · not warming'}` }
    case 'cold':
      return { color: 'warning', text: `cold · next turn rewrites ${fmtK(v.prefixTokens)} tok` }
    case 'paused':
      return { color: 'warning', text: `paused · ${narrow ? 'see /cachewarm' : v.paused}` }
  }
}

// The band's second line: the session totals.
function bandTotals(v: CacheView, narrow: boolean): string {
  const net = v.saved - v.spent
  const spentText = v.spentPct > 0 ? `${fmtUsd(v.spent)} (${v.spentPct.toFixed(1)}% of 5h)` : fmtUsd(v.spent)
  return (
    `${v.pings} ping${v.pings === 1 ? '' : 's'} · spent ${spentText} · saved ${fmtUsd(v.saved)} · net ` +
    (net >= 0 ? '+' : '') +
    fmtUsd(net) +
    (narrow || v.misses === 0 ? '' : ` · ${v.misses} miss${v.misses === 1 ? '' : 'es'}`) +
    (narrow || v.writes === 0 ? '' : ` · ${v.writes} rewrite${v.writes === 1 ? '' : 's'}`)
  )
}

async function runCommand($: EngineInterface, verb: string, arg: string | undefined, now: number): Promise<string> {
  switch (verb) {
    case 'off':
      S.overrideMode = 'off'
      await stopWarming($, 'turned off')
      S.idleNote = 'mode off'
      return 'cache-warm off for this session.'
    case 'on':
    case 'auto':
      return resume($, 'auto', now)
    case 'manual':
      if (minutesArg(arg)) S.overrideDuration = minutesArg(arg)
      return resume($, 'manual', now)
    case 'interval':
      return setPingInterval($, minutesArg(arg), now)
    case 'stop':
      await stopWarming($, 'stopped by /cachewarm stop')
      return 'stopped; the cache will lapse after the TTL.'
    case 'ping':
      return pingCommand($, arg === 'force', now)
    case 'band':
      return toggleBand($)
    case 'calc':
      return calcText()
    default:
      return statusText(now)
  }
}

// A command's minutes, 0 when not a usable number: never more than a day.
function minutesArg(arg: string | undefined): number {
  const n = Number(arg)
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_MINUTES) : 0
}

function setPingInterval($: EngineInterface, minutes: number, now: number): string {
  if (!minutes) return 'usage: /cachewarm interval <minutes>'
  S.overrideInterval = minutes * 60_000
  if (S.warming) {
    // The stop was planned for the old interval; a new one is no plan's end.
    S.stopAt = planStopAt(periodStart())
    schedulePing($, now, false)
  }
  return `interval ${fmtMin(intervalMs())} (clamped below the ${liveTtl()} TTL minus the margin).`
}

async function pingCommand($: EngineInterface, force: boolean, now: number): Promise<string> {
  const ph = phase(now)
  if (ph === 'none') return 'no turn yet: nothing is cached to ping.'
  // A fork re-sends the main thread's last request: until the next turn, the
  // conversation as it was before the compaction, which nothing sends again.
  if (S.coldPrefix === 'compacted') {
    return 'the conversation was compacted: a ping would warm it as it was before, which nothing sends again. The next turn writes the new one.'
  }
  if (S.coldPrefix && !force) return `nothing is cached for the next request (${S.idleNote || 'a new prefix'}); the next turn writes it.`
  if ((ph === 'cold' || ph === 'paused') && !force) {
    return `the cache expired ${fmtClock(expiresAt())}; a ping now would rewrite ${fmtK(S.prefixTokens)} tokens, not read them. /cachewarm ping force to do it anyway.`
  }
  return ping($, { manual: true, force })
}

async function toggleBand($: EngineInterface): Promise<string> {
  const isHidden = await read($, hidden)
  await setBandHidden($, !isHidden)
  return isHidden ? 'band shown' : 'band hidden (/cachewarm band to show it again)'
}

// Claude Code may compact an idle conversation ahead of the cache's expiry
// (v2.1.290+; whether it dispatches that as `auto` or `precompute` is not
// measured). While warming that discards history for nothing, so it is
// skipped. A compaction for room (the threshold, a prompt too long) is never
// skipped: one over a fuller window passes, as does any while a turn runs.
type CompactionSeen = { trigger: string; agentId?: string }

async function isIdleCompaction($: EngineInterface, e: CompactionSeen): Promise<boolean> {
  if (e.agentId !== undefined || (e.trigger !== 'auto' && e.trigger !== 'precompute')) return false
  if (!S.o.blockIdleCompaction || !S.warming || S.turnRunning) return false
  // The threshold auto-compaction runs at, which a compaction window smaller
  // than the model's or CLAUDE_AUTOCOMPACT_PCT_OVERRIDE moves down; the
  // model's window when the engine doesn't say. A summary is counted locally.
  const ctx = (await $.session.usage({ breakdown: 'summary' }).catch(() => undefined))?.context
  if (ctx?.tokens === undefined) return false
  const threshold = ctx.breakdown?.autoCompactThreshold ?? ctx.window
  return ctx.tokens < (COMPACT_FOR_ROOM_PCT / 100) * threshold
}

// The main conversation's compaction made a new prefix: nothing has cached
// it yet. A precompute installs nothing.
async function noteCompacted($: EngineInterface, e: CompactionSeen, tokensAfter?: number): Promise<void> {
  if (e.agentId !== undefined || e.trigger === 'precompute') return
  await markCold($, 'compacted', S.compacting || 'the conversation was compacted', tokensAfter)
}

// ---- hooks ---------------------------------------------------------------------

async function onSessionStart($: EngineInterface): Promise<void> {
  const registered = $.command
    .register({
      name: 'cachewarm',
      description: 'Prompt-cache warmer: status, calc, on, off, auto, manual <min>, interval <min>, ping, stop, band',
      argumentHint: '[status|calc|on|off|auto|manual <min>|interval <min>|ping [force]|stop|band]',
      immediate: true,
    })
    .catch(() => undefined)
  // Session totals and the kept state live in $.state, which survives a hot
  // reload of the module.
  const [kept, k, isHidden] = await Promise.all([read($, view), read($, keep), read($, hidden)])
  S.bandHidden = isHidden
  try {
    await configure($, kept, k)
  } catch (err) {
    $.ui.log(`could not read the cache configuration: ${String(err)}`)
  }
  const wasWarming = restore(kept, k)
  syncTicker($)
  await registered
  await publish($)
  if (wasWarming) quiet(startWarming($, await $.clock.now()))
}

async function onSessionEnd($: EngineInterface, reason: string): Promise<void> {
  if (reason === 'clear' || reason === 'resume') {
    // The process goes on with another conversation, and no session.start
    // fires for it: start the conversation over, keep the session totals and
    // the band.
    resetConversation()
    await publish($)
    return
  }
  clearWarming()
  S.ticker?.cancel()
  S.ticker = undefined
}

async function onTurnStart($: EngineInterface): Promise<void> {
  S.turnRunning = true
  S.turnSteps = 0
  clearWarming() // the user is back: every real request refreshes the cache
  const now = await $.clock.now()
  // A ping still in flight counts: it most likely refreshed the entry.
  const pings = S.idlePings + (S.pinging ? 1 : 0)
  ;[S.gapPings, S.gapTtl] = [pings, liveTtl()]
  // Did pings carry the cache through an idle period longer than the TTL?
  // Without them the first request now would be a cold rewrite. The first
  // turn.step of this turn settles it by what the API actually served. A
  // return inside the TTL is no verdict either way.
  // The idle period itself ends with the turn's first request: a turn cut
  // off before it sends one refreshed nothing.
  const idleMs = S.idleStartAt ? now - S.idleStartAt : 0
  const autoPings = S.idleAutoPings + (S.pinging === 'auto' ? 1 : 0)
  S.pendingReturn =
    pings > 0 && idleMs > TTL_MS[liveTtl()] ? { prefix: S.prefixTokens, saving: econNow().saving, pings, autoPings } : undefined
  await publish($, now)
}

// A main-thread request's usage: settles a pending return, learns the TTL and
// the main thread's cache health, and restarts the TTL clock from `started`.
function noteMainRequest($: EngineInterface, u: TurnUsage, started: number, sentTtl: Ttl): void {
  const outcome = classify(u, S.prefixTokens)
  S.turnSteps += 1
  if (S.turnSteps === 1) beginIdlePeriod(0) // from here the turn keeps the cache
  const gap = S.lastRequestAt ? started - S.lastRequestAt : 0
  // A prefix nothing cached (after a compaction or a model switch) is written
  // whatever the TTL: no evidence about it, or about caching.
  const wasCold = S.coldPrefix
  if (S.pendingReturn) {
    const r = S.pendingReturn
    S.pendingReturn = undefined
    settleReturn($, r, u)
  }
  // Only a turn's first request has an idle gap behind it; a gap inside a turn
  // (a long tool call) may have had another plugin's forks refresh the entry.
  const learned = !wasCold && S.turnSteps === 1 && S.gapPings === 0 && S.prefixTokens > 0 && observeTtl(outcome, gap)
  if (!wasCold) noteMainHealth($, outcome, gap)
  S.gapPings = 0
  S.coldPrefix = ''
  // Everything the request carried is the prefix the next cold turn rewrites.
  S.prefixTokens = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
  if (u.model && u.model !== S.model) {
    S.model = u.model
    settleTtl()
  }
  S.lastRequestAt = started
  S.lastRequestTtl = learned ? S.ttl : sentTtl
}

// Cache health of the main thread itself: a rewrite of a prefix that should
// still have been warm, twice in a row, means caching isn't working here, and
// pings would only add to the bill.
function noteMainHealth($: EngineInterface, outcome: CacheOutcome, gap: number): void {
  if (S.prefixTokens <= minCacheable(S.model) || gap <= 0 || gap >= TTL_MS[S.gapTtl] - marginMs()) return
  if (outcome === 'write' || outcome === 'none') S.mainWrites += 1
  else if (outcome === 'hit') S.mainWrites = 0
  if (S.mainWrites !== 2) return
  $.ui.log(
    outcome === 'none'
      ? 'the last two requests were billed uncached: a gateway may be stripping cache_control; warming is off until a request reads the cache'
      : 'the last two requests rewrote the prefix; warming is off until a request reads the cache',
  )
}

async function onTurnComplete($: EngineInterface): Promise<void> {
  // Read first, so the idle period is whole the moment the turn is over: a
  // /cachewarm command arriving in between never sees half of it.
  const [now, model] = await Promise.all([$.clock.now(), $.session.model().catch(() => S.sessionModel)])
  S.turnRunning = false
  clearWarming()
  S.sessionModel = model
  // A turn that sent no request (cut off first) refreshed nothing: the idle
  // period it interrupted goes on, with what it has spent, and is judged
  // whole when a request comes.
  if (S.turnSteps > 0 || !S.idleStartAt) beginIdlePeriod(S.lastRequestAt)
  else S.pendingReturn = undefined
  await publish($, now)
  const force = S.forceNext // /cachewarm on during the turn
  S.forceNext = false
  quiet(startWarming($, now, force))
  quiet(recordForcedTtl($))
}

// A model switched while idle has no cache yet: the next turn writes it, and
// a ping would pay for that write. `to` is the resolved model id. During a
// turn the next request is the one that writes the new model's prefix: no
// evidence about the TTL or caching.
async function onModelSwitch($: EngineInterface, from: string, to: string): Promise<void> {
  if (!to || to === from) return
  S.model = to
  settleTtl()
  if (!S.lastRequestAt) return
  if (S.turnRunning) {
    S.coldPrefix = 'model'
    S.pendingReturn = undefined
    return
  }
  await markCold($, 'model', `the model changed to ${to}; its cache starts with the next turn`)
}

export const register: Register = (on, options) => {
  S.o = { ...S.o, ...(options as unknown as Partial<Options>) }

  on('session.start', async ($, e, next) => {
    await onSessionStart($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await onSessionEnd($, e.reason)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await onTurnStart($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // The TTL runs from the request's start, not from the end of its response:
    // a long generation eats into the window, so take the time before sending,
    // and the TTL mode it goes out in, before its own response can move it.
    const started = e.agentId === undefined ? await $.clock.now() : 0
    const sentTtl = S.ttl
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) {
      noteMainRequest($, result.usage, started, sentTtl)
      quiet(publish($))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await onTurnComplete($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    noteRateLimits(e.rateLimits)
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await onModelSwitch($, e.from_model, e.to_model)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    if (await isIdleCompaction($, e)) return { skip: 'cache-warm is keeping this conversation warm; idle compaction skipped' }
    const r = await next(e)
    if (r.messages) await noteCompacted($, e, r.tokensAfter)
    return r
  }).catch(($, e, next) => next(e)) // a failure here never blocks or changes a compaction

  // The band above the prompt: TTL, cache countdown, next ping, session totals.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    // Reading `hidden` here redraws the band the moment it changes.
    if (!S.o.showBand || e.props.hasSurvey || v === null || (await read($, hidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const narrow = e.props.bodyColumns < 100
    const state = bandState(v, narrow)
    const ttlText = `TTL ${v.ttl}${v.refreshTtl !== v.ttl ? `→${v.refreshTtl}` : ''}${narrow ? '' : ` (${v.ttlSource})`}`
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>cache </Text>
          <Text color={state.color}>{state.text}</Text>
          <Text dimColor>
            {' · '}
            {ttlText}
            {v.prefixTokens ? ` · ${fmtK(v.prefixTokens)} tok` : ''}
          </Text>
        </Box>
        <Box>
          <Text dimColor>
            {'      '}
            {bandTotals(v, narrow)}{' '}
          </Text>
          <Button key="hide" label="hide" plain onPress={() => quiet(setBandHidden($, true))} />
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'cachewarm' }, async ($, e) => {
    const [verb = 'status', arg] = (e.args || '').trim().split(/\s+/)
    const text = await runCommand($, verb, arg, await $.clock.now())
    quiet(publish($)) // an override set while nothing else publishes survives a reload too
    return { text }
  })
}
