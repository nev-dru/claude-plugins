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
  showBand: boolean
  verbose: boolean
}

// Base input price in USD per MTok and the cache-read multiplier vs base, from
// the Claude pricing table (platform.claude.com/docs/en/build-with-claude/prompt-caching).
// Output is ~5x base input across the lineup. Order matters: first match wins.
// Bedrock/Vertex rates may differ: override with inputPricePerMTok / cacheReadMultiplier.
const PRICES: { re: RegExp; input: number; read: number; longInput?: number }[] = [
  { re: /fable-5-1|mythos-5-1/, input: 10, read: 0.025 },
  { re: /fable-5|mythos-5/, input: 10, read: 0.1 },
  { re: /opus-5-5/, input: 4, read: 0.05 },
  { re: /sonnet-5-5/, input: 2, read: 0.05 },
  { re: /haiku-5-5/, input: 0.1, read: 0.1, longInput: 0.5 },
  { re: /opus-5/, input: 5, read: 0.1 },
  { re: /opus-4-[5-8]/, input: 5, read: 0.1 },
  { re: /opus-4/, input: 15, read: 0.1 },
  { re: /sonnet-5/, input: 2, read: 0.1 },
  { re: /sonnet-4/, input: 3, read: 0.1 },
  { re: /haiku-4-5/, input: 1, read: 0.1 },
  { re: /haiku-3-5/, input: 0.8, read: 0.1 },
]
const OUTPUT_RATIO = 5
const WRITE_MULT: Record<Ttl, number> = { '5m': 1.25, '1h': 2 }
const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const SAFETY_MS = 45_000 // the lifetime runs from the request's start; pings take time
const PING_PROMPT =
  'Cache keep-alive ping. Reply with exactly one character: "." Do not call any tool. Do not explain.'

type Pricing = { input: number; read: number; output: number; known: boolean }

// ---- pure math ---------------------------------------------------------------

export function pricing(model: string, prefix: number, o: Options): Pricing {
  const row = PRICES.find((p) => p.re.test(model))
  let input = row ? (row.longInput && prefix > 100_000 ? row.longInput : row.input) : 3
  let read = row ? row.read : 0.1
  if (o.inputPricePerMTok > 0) input = o.inputPricePerMTok
  if (o.cacheReadMultiplier > 0) read = o.cacheReadMultiplier
  return { input, read, output: input * OUTPUT_RATIO, known: !!row }
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
  // a return to check: did pings keep the cache warm through an idle period
  // longer than the TTL? Resolved by the first request of the next turn.
  pendingReturn: undefined as { prefix: number; saving: number } | undefined,
  // session totals
  pings: 0,
  spent: 0,
  saved: 0,
  spentPct: 0,
  returnsWarm: 0,
  returnsCold: 0,
  misses: 0,
  // /cachewarm overrides for this session
  overrideMode: undefined as Mode | undefined,
  overrideInterval: undefined as number | undefined,
  overrideDuration: undefined as number | undefined,
}

function mode(): Mode {
  return S.overrideMode ?? S.o.mode
}

function intervalMs(): number {
  const want =
    S.overrideInterval ?? (S.o.intervalMinutes > 0 ? S.o.intervalMinutes * 60_000 : defaultIntervalMs(S.ttl))
  return Math.max(30_000, Math.min(want, TTL_MS[S.ttl] - SAFETY_MS))
}

function priceNow(): Pricing {
  return pricing(S.model, S.prefixTokens, S.o)
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
  return now - S.lastRequestAt < TTL_MS[S.ttl] ? 'warm' : 'cold'
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
    idlePings: S.idlePings,
    idleSpent: S.idleSpent,
    pings: S.pings,
    spent: S.spent,
    saved: S.saved,
    spentPct: S.spentPct,
    returnsWarm: S.returnsWarm,
    returnsCold: S.returnsCold,
    misses: S.misses,
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

async function startWarming($: EngineInterface, now: number): Promise<void> {
  if (mode() === 'off' || S.warming) return
  if (S.prefixTokens < 1024) {
    // Below every model's minimum cacheable prefix there is nothing to keep warm.
    try {
      S.prefixTokens = (await $.session.usage()).context.tokens ?? 0
    } catch {}
    if (S.prefixTokens < 1024) return
  }
  S.warming = true
  S.idlePings = S.idleMisses = 0
  S.idleSpent = S.idleSpentPct = 0
  S.avgPingUsd = undefined
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
  if (!S.warming || S.turnRunning) return
  let before: SessionUsage | undefined
  try {
    before = await $.session.usage()
  } catch {}
  const t0 = await $.clock.now()
  const r = await $.model.fork({ prompt: PING_PROMPT })
  const t1 = await $.clock.now()
  if (!('usage' in r)) {
    await stopWarming($, 'nothing to fork yet (no completed turn in this conversation)')
    return
  }
  if (!r.isAnswered && r.reason === 'api-error') {
    S.idleMisses += 1
    S.misses += 1
    $.ui.log(`ping failed: ${r.error} (${r.status ?? 'no response'})`)
    if (S.idleMisses >= 3) {
      await stopWarming($, 'three failed pings')
      return
    }
    schedulePing($, t1)
    return
  }
  S.lastRequestAt = t0
  const u = r.usage
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

  const hit = u.cache_read_input_tokens >= 0.8 * S.prefixTokens
  if (S.o.verbose || !hit) {
    $.ui.log(
      `ping #${S.idlePings}: read ${fmtK(u.cache_read_input_tokens)} · wrote ${fmtK(u.cache_creation_input_tokens)} · ` +
        `uncached ${fmtK(u.input_tokens)} · out ${u.output_tokens} · ${fmtUsd(cost)} · ${((t1 - t0) / 1000).toFixed(1)}s` +
        (hit ? '' : ' · MISS: the prefix was not served from cache'),
    )
  }
  if (!hit) {
    S.idleMisses += 1
    S.misses += 1
    if (S.idlePings === 1) {
      // The very first ping should always hit: the main thread just ran. A
      // miss here means the fork's request differs from the main thread's
      // (a gateway rewriting cache_control, a provider quirk, an unsupported
      // model). Pinging would then cost a full rewrite each time, so stop.
      await stopWarming($, 'first ping missed the cache; see /cachewarm calc and VALIDATE.md')
      return
    }
    if (S.idleMisses >= 2) {
      await stopWarming($, 'repeated cache misses; shorten intervalMinutes or check the provider')
      return
    }
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
    ` · $${p.input}/MTok base input${p.known ? '' : ' (model not in table, using $3)'}\n` +
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
  const head = `${S.provider} · TTL ${S.ttl} (${S.ttlSource}) · model ${S.model || '?'} · prefix ${fmtK(S.prefixTokens)} tokens`
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
      // Did pings carry the cache through an idle period longer than the TTL?
      // Without them the first request now would be a cold rewrite. The first
      // turn.step of this turn settles it by what the API actually served.
      const idleMs = S.idleStartAt ? now - S.idleStartAt : 0
      if (S.idlePings > 0 && idleMs > TTL_MS[S.ttl]) {
        const ec = economics(S.prefixTokens, S.ttl, priceNow(), S.avgPingUsd)
        S.pendingReturn = { prefix: S.prefixTokens, saving: ec.saving }
      } else {
        S.pendingReturn = undefined
      }
      S.turnRunning = true
      clearWarming() // the user is back: every real request refreshes the cache
      await publish($)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) {
      const u = result.usage
      if (S.pendingReturn) {
        const hit = u.cache_read_input_tokens >= 0.8 * S.pendingReturn.prefix
        if (hit) {
          S.saved += S.pendingReturn.saving
          S.returnsWarm += 1
          if (S.o.verbose) $.ui.log(`warm return: saved ${fmtUsd(S.pendingReturn.saving)}`)
        } else {
          S.returnsCold += 1
          $.ui.log(`cold return despite ${S.idlePings} pings: the API rewrote ${fmtK(u.cache_creation_input_tokens)} tokens`)
        }
        S.pendingReturn = undefined
      }
      // Everything the request carried is the prefix the next cold turn rewrites.
      S.prefixTokens = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens
      S.model = u.model || S.model
      S.lastRequestAt = await $.clock.now()
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
    }
    const net = v.saved - v.spent
    const spentText = v.spentPct > 0 ? `${fmtUsd(v.spent)} (${v.spentPct.toFixed(1)}% of 5h)` : fmtUsd(v.spent)
    const totals =
      `${v.pings} ping${v.pings === 1 ? '' : 's'} · spent ${spentText} · saved ${fmtUsd(v.saved)} · net ` +
      (net >= 0 ? '+' : '') +
      fmtUsd(net) +
      (narrow || v.misses === 0 ? '' : ` · ${v.misses} miss${v.misses === 1 ? '' : 'es'}`)

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
      case 'auto':
        S.overrideMode = 'auto'
        if (!S.warming) void startWarming($, now)
        return { text: `cache-warm auto: ping every ${fmtMin(intervalMs())} until break-even × ${S.o.stopFraction}.` }
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
