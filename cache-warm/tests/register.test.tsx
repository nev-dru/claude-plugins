import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On } from 'claude-code'

import type { CacheView, KeptState } from '../types'

import { classify, economics, minCacheable, pricing } from '../hooks/register.js'

const OPTS = {
  mode: 'auto',
  intervalMinutes: 0,
  durationMinutes: 120,
  stopFraction: 1,
  ttl: 'detect',
  inputPricePerMTok: 0,
  cacheReadMultiplier: 0,
  endAction: 'lapse',
  blockIdleCompaction: true,
  forceTtl: 'off',
  showBand: true,
  verbose: false,
} as const

const PREFIX = 50_000
const MIN = 60_000

function usage(read: number, wrote: number) {
  return { input_tokens: 4, cache_creation_input_tokens: wrote, cache_read_input_tokens: read, output_tokens: 1 }
}

describe('pure math', () => {
  test('Claude 3.5 Haiku is priced from its own row', async () => {
    const o = { ...OPTS }
    expect(pricing('claude-3-5-haiku-20241022', PREFIX, o).input).toBe(0.8)
    expect(pricing('anthropic.claude-3-5-haiku-20241022-v1:0', PREFIX, o).known).toBe(true)
    expect(minCacheable('claude-3-5-haiku-20241022')).toBe(2048)
  })

  test('classify judges by what was read', async () => {
    expect(classify(usage(45_000, 4), PREFIX)).toBe('hit')
    expect(classify(usage(20_000, 30_000), PREFIX)).toBe('partial')
    expect(classify(usage(0, 50_000), PREFIX)).toBe('write')
    expect(classify(usage(0, 0), PREFIX)).toBe('none')
  })

  test('break-even does not depend on prefix size', async () => {
    const p = pricing('claude-opus-4-8', PREFIX, { ...OPTS })
    const small = economics(200_000, '1h', p).pings
    const large = economics(2_000_000, '1h', p).pings
    expect(Math.abs(small - large) < 0.1).toBe(true)
  })
})

// The engine beneath the plugin: every call it makes is answered here.
type World = {
  env?: Record<string, string>
  model?: string
  settings?: Record<string, unknown>
  rateLimits?: { kind: string; percentUsed: number }[]
  fork?: () => ModelForkResult
  step?: () => ReturnType<typeof usage>
  compacted?: string[]
  forks?: { n: number }
  envSets?: [string, string | undefined][]
  envDeny?: string // a variable whose write a hook denies
  store?: Record<string, unknown>
  answered?: boolean // the transcript holds a reply from before this process
  unreadable?: boolean // the transcript can't be read
  spend?: number // what each fork adds to the session's cost ledger
  context?: Record<string, unknown> // the context window session.usage reports
  storeFails?: { n: number } // store writes that fail before one succeeds
}

function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, w.env ?? {})
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // A streaming event's hook is a generator; this one streams nothing.
  // oxlint-disable-next-line require-yield
  on('turn.step', async function* (_, e) {
    const u = w.step ? w.step() : usage(0, PREFIX)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...u, model: e.model } }
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('command.register', () => ({ value: { command: 'cachewarm' } }))
  on('session.model', () => ({ value: w.model ?? 'claude-opus-4-8' }))
  on('session.messages', () => ({ value: w.answered ? [{ role: 'assistant' as const, text: 'earlier', toolUses: [] }] : [] }))
  on('settings.read', () => ({ value: w.settings ?? {} }))
  on('env.set', (_, e) => {
    w.envSets?.push([e.name, e.value])
    return e.name === w.envDeny ? { deny: 'blocked by a hook' } : { value: {} }
  })
  on('session.turns', () => {
    if (w.unreadable) throw new Error('no transcript')
    return { value: w.answered ? 2 : 0 }
  })
  on('session.id', () => ({ value: 's1' }))
  const store = w.store ?? {}
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    if (w.storeFails && w.storeFails.n-- > 0) throw new Error('store busy')
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.delete', (_, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('classic.PostModelSwitch', () => ({}))
  on('ui.log', () => ({ value: undefined }))
  let ledger = 0
  on('session.usage', () => ({
    value: {
      startedAt: clock.now(),
      context: (w.context ?? { tokens: PREFIX, window: 200_000, percent: 25 }) as { window: number },
      rateLimits: w.rateLimits ?? [],
      cost: { usd: ledger },
    },
  }))
  on('model.fork', () => {
    if (w.forks) w.forks.n += 1
    ledger += w.spend ?? 0
    const r: ModelForkResult = w.fork ? w.fork() : { isAnswered: true, text: '.', usage: usage(PREFIX, 4) }
    return { value: r }
  })
  on('session.compact', (_, e) => {
    w.compacted?.push(e.instructions ?? '')
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensAfter: 5_000 }
  })
  return clock
}

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

async function step($: Engine) {
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-4-8', messageCount: 2 })
  for await (const chunk of s) void chunk
  await s.result
}

async function turn($: Engine, clock: { settle: () => Promise<void> }) {
  await $.turn.start({ text: 'hi', turnId: 't' })
  await step($)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.settle()
}

async function status($: Engine, args = 'status'): Promise<string> {
  const r = await $.command.run({
    command: 'cachewarm',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  return r.text ?? ''
}

const BAND = {
  plugin: 'cache-warm',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the band turns cold once the cache lapses', { options: { ...OPTS, mode: 'off' } }, async ($, on) => {
  const clock = world(on)
  await start($)
  await turn($, clock)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /warm · expires/ }))?.text).toContain('warming off')
  await clock.advance(61 * MIN)
  expect((await ui.find({ type: 'Text', text: /cold · next turn rewrites/ }))?.text).toContain('50k tok')
  await ui.unmount()
})

test('/cachewarm off never compacts the conversation', { options: { ...OPTS, endAction: 'compact' } }, async ($, on) => {
  const compacted: string[] = []
  const forks = { n: 0 }
  const clock = world(on, { compacted, forks, settings: { promptCacheTtl: '5m' }, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  await turn($, clock)
  await clock.advance(4 * MIN + 1000)
  expect(forks.n).toBe(1)
  await status($, 'off')
  expect(compacted.length).toBe(0)
})

test('break-even compacts while the cache is warm', { options: { ...OPTS, endAction: 'compact', stopFraction: 0.1 } }, async ($, on) => {
  const compacted: string[] = []
  const clock = world(on, { compacted, settings: { promptCacheTtl: '5m' }, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  await turn($, clock)
  await clock.advance(4 * MIN + 1000) // the first ping passes break-even × 0.1
  expect(compacted.length).toBe(1)
  expect(await status($)).toContain('cold (compacted at the break-even point): the next turn rewrites 5.0k tokens')
})

test('the ping refresh follows the entry TTL when the plan runs out', { options: OPTS }, async ($, on) => {
  const clock = world(on)
  await start($)
  await turn($, clock)
  expect(await status($)).toContain('entry TTL 1h (subscription default) · ping refresh 1h')
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100 }], changed: ['rateLimits'] })
  expect(await status($)).toContain('entry TTL 5m (subscription over plan usage) · ping refresh 5m')
})

test('Bedrock 3.5 Sonnet is held to the 5-minute TTL', { options: OPTS }, async ($, on) => {
  world(on, {
    env: { CLAUDE_CODE_USE_BEDROCK: '1' },
    model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    settings: { promptCacheTtl: '1h' },
  })
  await start($)
  expect(await status($, 'calc')).toContain('entry TTL 5m (bedrock: this model supports the 5-minute TTL only)')
})

test('/cachewarm manual during a turn waits for the turn to end', { options: OPTS }, async ($, on) => {
  const forks = { n: 0 }
  const clock = world(on, { forks })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't' })
  expect(await status($, 'manual 60')).toContain('from the end of this turn')
  await clock.advance(70 * MIN)
  expect(forks.n).toBe(0)
  await step($) // the turn's last request
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await clock.advance(56 * MIN)
  expect(forks.n).toBe(1)
})

test('/cachewarm ping force pings a cold cache', { options: { ...OPTS, mode: 'off' } }, async ($, on) => {
  const forks = { n: 0 }
  const clock = world(on, { forks, fork: () => ({ isAnswered: true, text: '.', usage: usage(0, PREFIX) }) })
  await start($)
  await turn($, clock)
  await clock.advance(61 * MIN)
  expect(await status($, 'ping')).toContain('ping force')
  expect(forks.n).toBe(0)
  expect(await status($, 'ping force')).toContain('MISS (write)')
  expect(forks.n).toBe(1)
  expect(await status($)).not.toContain('PAUSED')
})

test('an aborted ping is tried again, without a pause', { options: OPTS }, async ($, on) => {
  let n = 0
  const clock = world(on, {
    fork: () => (n++ === 0 ? { isAnswered: false, reason: 'aborted', usage: usage(0, 0) } : { isAnswered: true, text: '.', usage: usage(PREFIX, 4) }),
  })
  await start($)
  await turn($, clock)
  await clock.advance(56 * MIN)
  expect(n).toBe(2)
  const s = await status($)
  expect(s).not.toContain('PAUSED')
  expect(s).toContain('warming ·')
})

test('/clear starts the conversation over', { options: OPTS }, async ($, on) => {
  const clock = world(on)
  await start($)
  await turn($, clock)
  await clock.advance(56 * MIN)
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  const s = await status($)
  expect(s).toContain('no turn yet')
  expect(s).toContain('session: 1 pings')
})

const AUTO = { ...OPTS, forceTtl: 'auto' } as const

test('forceTtl auto sets both TTL variables at session start, and records them', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  const store: Record<string, unknown> = {}
  const clock = world(on, { envSets, store, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  expect(envSets).toEqual([
    ['CLAUDE_CODE_PROMPT_CACHE_TTL', '1h'],
    ['CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', '1h'],
  ])
  expect(await status($)).toContain('entry TTL 1h (set by cache-warm)')
  await turn($, clock)
  expect(store['ttl:s1']).toEqual({ ttl: '1h', at: clock.now() })
})

test('forceTtl auto leaves a subscription at its own 1h default', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  world(on, { envSets })
  await start($)
  expect(envSets.length).toBe(0)
  expect(await status($)).toContain('entry TTL 1h (subscription default)')
})

test('a conversation with requests from before cache-warm keeps its TTL', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  world(on, { envSets, answered: true, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  expect(envSets.length).toBe(0)
})

test('forceTtl auto leaves a TTL the user chose', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  world(on, { envSets, env: { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
  await start($)
  expect(envSets.length).toBe(0)
  expect(await status($)).toContain('entry TTL 5m (CLAUDE_CODE_PROMPT_CACHE_TTL)')
})

test('a refused subagent TTL puts the main one back', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  world(on, { envSets, envDeny: 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  expect(envSets).toEqual([
    ['CLAUDE_CODE_PROMPT_CACHE_TTL', '1h'],
    ['CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', '1h'],
    ['CLAUDE_CODE_PROMPT_CACHE_TTL', undefined],
  ])
  expect(await status($)).toContain('api-key · entry TTL 5m (api-key default)')
})

test('a resumed conversation gets the TTL on record for it', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  const store = { 'ttl:s1': { ttl: '1h', at: 1_000_000 } }
  world(on, { envSets, store, answered: true, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  expect(envSets).toEqual([
    ['CLAUDE_CODE_PROMPT_CACHE_TTL', '1h'],
    ['CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', '1h'],
  ])
})

test('a /resume mid-process never changes the TTL variables', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  const clock = world(on, { envSets, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  await turn($, clock)
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await turn($, clock)
  expect(envSets.length).toBe(2)
})

test('manual mode still stops when a ping costs more than half a rewrite', { options: { ...OPTS, mode: 'manual' } }, async ($, on) => {
  const forks = { n: 0 }
  const clock = world(on, {
    forks,
    settings: { promptCacheTtl: '5m' },
    env: { ANTHROPIC_API_KEY: 'k' },
    fork: () => ({ isAnswered: true, text: '.', usage: usage(20_000, 30_000) }),
  })
  await start($)
  await turn($, clock)
  await clock.advance(5 * MIN)
  expect(await status($)).toContain('not worth it here')
  await clock.advance(10 * MIN)
  expect(forks.n).toBe(1)
})

test('a ping that reads almost nothing pauses rather than pinging again', { options: { ...OPTS, mode: 'manual' } }, async ($, on) => {
  const forks = { n: 0 }
  const clock = world(on, { forks, fork: () => ({ isAnswered: true, text: '.', usage: usage(500, 0) }) })
  await start($)
  await turn($, clock)
  await clock.advance(57 * MIN)
  expect(forks.n).toBe(1)
  expect(await status($)).toContain('PAUSED: pings are not cached')
})

test('/cachewarm on never warms through a TTL mismatch', { options: OPTS }, async ($, on) => {
  const forks = { n: 0 }
  const clock = world(on, { forks, settings: { subagentPromptCacheTtl: '5m' } })
  await start($)
  await turn($, clock)
  expect(await status($, 'on')).toContain('Not warming this idle period: held: subagentPromptCacheTtl setting is 5m')
  await clock.advance(61 * MIN)
  expect(forks.n).toBe(0)
})

test('a TTL that moves mid-idle stops warming before a ping can rewrite', { options: OPTS }, async ($, on) => {
  const forks = { n: 0 }
  const clock = world(on, { forks })
  await start($)
  await turn($, clock)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100 }], changed: ['rateLimits'] })
  await clock.advance(56 * MIN)
  expect(forks.n).toBe(0)
  expect(await status($)).toContain('the cache TTL moved from 1h to 5m')
})

test('an overloaded ping is tried again with backoff', { options: OPTS }, async ($, on) => {
  let n = 0
  const clock = world(on, {
    fork: () =>
      n++ === 0
        ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: usage(0, 0) }
        : { isAnswered: true, text: '.', usage: usage(PREFIX, 4) },
  })
  await start($)
  await turn($, clock)
  await clock.advance(56 * MIN)
  expect(n).toBe(2)
  expect(await status($)).toContain('warming ·')
})

test('a model switch while idle leaves the cache cold and sends no pings', { options: OPTS }, async ($, on) => {
  const forks = { n: 0 }
  const clock = world(on, { forks })
  await start($)
  await turn($, clock)
  await $.classic.PostModelSwitch({
    from_model: 'claude-opus-4-8',
    to_model: 'claude-sonnet-4-5',
    requested_model: 'sonnet',
    source: 'command',
    context_tokens: PREFIX,
    prompt_cache_warm: true,
    cache_ttl: '1h',
    estimated_cache_write_usd: 0.3,
    pricing: 'catalog',
  })
  await clock.advance(56 * MIN)
  expect(forks.n).toBe(0)
  expect(await status($)).toContain('cold (the model changed to claude-sonnet-4-5')
})

function keptView(now: number, phase: CacheView['phase']): CacheView {
  return {
    now,
    phase,
    ttl: '1h',
    ttlSource: 'subscription default',
    refreshTtl: '1h',
    liveTtl: '1h',
    provider: 'subscription',
    model: 'claude-opus-4-8',
    prefixTokens: PREFIX,
    lastRequestAt: now - MIN,
    nextPingAt: 0,
    stopAt: 0,
    mode: 'off',
    marginMs: 45_000,
    rttMs: 0,
    paused: '',
    pings: 3,
    spent: 0.1,
    saved: 0,
    spentPct: 0,
    returnsWarm: 0,
    returnsCold: 0,
    misses: 0,
    writes: 0,
  }
}

function keptState(now: number, overrideMode?: 'off'): KeptState {
  return {
    coldPrefix: '',
    idleNote: 'mode off',
    idleTtl: '1h',
    idleStartAt: now - MIN,
    idlePings: 0,
    idleAutoPings: 0,
    idleWrites: 0,
    idleErrors: 0,
    idleSpent: 0,
    idleSpentPct: 0,
    overrideMode,
    mainWrites: 0,
    consecutiveLosses: 0,
    firstPingWrites: 0,
    paused: '',
    forcedTtl: '',
    lastRequestTtl: '1h',
  }
}

// What an earlier load of the module left in $.state, read once.
function seedState(on: On, seeds: Record<string, (now: number) => unknown>, clock: { now: () => number }) {
  const read = new Set<string>()
  on('state.get', (_, e, next) => {
    const seed = seeds[e.key]
    if (!seed || read.has(e.key)) return next(e)
    read.add(e.key)
    return { value: { value: seed(clock.now()), version: 1 } }
  })
}

test('a hot reload while warming picks warming up again', { options: OPTS }, async ($, on) => {
  const forks = { n: 0 }
  const clock = world(on, { forks })
  seedState(on, { view: (now) => keptView(now, 'warming'), keep: (now) => keptState(now) }, clock)
  await start($)
  await clock.settle()
  expect(await status($)).toContain('warming ·')
  await clock.advance(55 * MIN)
  expect(forks.n).toBe(1)
})

test('a hot reload keeps /cachewarm off and the session totals', { options: OPTS }, async ($, on) => {
  const forks = { n: 0 }
  const clock = world(on, { forks })
  seedState(on, { view: (now) => keptView(now, 'warm'), keep: (now) => keptState(now, 'off') }, clock)
  await start($)
  await turn($, clock)
  await clock.advance(56 * MIN)
  expect(forks.n).toBe(0)
  const s = await status($)
  expect(s).toContain('not warming: mode off')
  expect(s).toContain('session: 3 pings')
})

test('/cachewarm manual never compacts, even with endAction compact', { options: { ...OPTS, endAction: 'compact' } }, async ($, on) => {
  const compacted: string[] = []
  const clock = world(on, { compacted, settings: { promptCacheTtl: '5m' }, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  await turn($, clock)
  await clock.advance(6 * MIN) // the first ping went out at 4m
  expect(await status($, 'manual 7')).toContain('Not warming this idle period')
  expect(compacted.length).toBe(0)
})

test('the hide button hides the band', { options: { ...OPTS, mode: 'off' } }, async ($, on) => {
  const clock = world(on)
  // Beneath the band, the engine draws its own; this stands in for it.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($)
  await turn($, clock)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /warm · expires/ })).toBeDefined()
  await ui.press({ key: 'hide' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /warm · expires/ })).toBeUndefined()
  await ui.unmount()
})

test('a record never overrides a TTL the user chose', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  const store = { 'ttl:s1': { ttl: '1h', at: 1_000_000 } }
  world(on, { envSets, store, answered: true, env: { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } })
  await start($)
  expect(envSets.length).toBe(0)
})

test('a record never forces a TTL through a gateway', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  const store = { 'ttl:s1': { ttl: '1h', at: 1_000_000 } }
  world(on, { envSets, store, answered: true, env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://litellm:4000' } })
  await start($)
  expect(envSets.length).toBe(0)
})

test('an expired record counts for nothing', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  const store = { 'ttl:s1': { ttl: '1h', at: 1_000_000 - 31 * 24 * 60 * MIN } }
  world(on, { envSets, store, answered: true, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  expect(envSets.length).toBe(0)
})

test('a transcript that cannot be read leaves the TTL alone', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  world(on, { envSets, unreadable: true, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  expect(envSets.length).toBe(0)
})

test('an apiKeyHelper session counts as an API key', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  world(on, { envSets, settings: { apiKeyHelper: '~/bin/key' } })
  await start($)
  expect(envSets.length).toBe(2)
  expect(await status($)).toContain('api-key · entry TTL 1h (set by cache-warm)')
})

test('an AWS load balancer in front of Bedrock is a gateway', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  world(on, {
    envSets,
    env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: 'https://internal-litellm-1.us-east-1.elb.amazonaws.com' },
  })
  await start($)
  expect(envSets.length).toBe(0)
  expect(await status($)).toContain('gateway ·')
})

test('a Bedrock VPC endpoint is still Bedrock', { options: AUTO }, async ($, on) => {
  world(on, {
    env: { CLAUDE_CODE_USE_BEDROCK: 'TRUE', ANTHROPIC_BEDROCK_BASE_URL: 'https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com' },
  })
  await start($)
  expect(await status($)).toContain('bedrock · entry TTL 1h (set by cache-warm)')
})

test('a TTL mismatch clears itself when the TTLs agree again', { options: OPTS }, async ($, on) => {
  const clock = world(on, { settings: { subagentPromptCacheTtl: '1h' } })
  await start($)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100 }], changed: ['rateLimits'] })
  expect(await status($)).toContain('HELD: subagentPromptCacheTtl setting is 1h')
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], changed: ['rateLimits'] })
  await turn($, clock)
  const s = await status($)
  expect(s).not.toContain('HELD')
  expect(s).toContain('warming ·')
})

test('a forced rewrite of a cold cache can be warmed again', { options: { ...OPTS, mode: 'off' } }, async ($, on) => {
  const clock = world(on, { fork: () => ({ isAnswered: true, text: '.', usage: usage(0, PREFIX) }) })
  await start($)
  await turn($, clock)
  await clock.advance(61 * MIN)
  expect(await status($, 'ping force')).toContain('MISS (write)')
  expect(await status($, 'on')).not.toContain('Not warming')
})


test('a regional Vertex endpoint is still Vertex', { options: AUTO }, async ($, on) => {
  world(on, { env: { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_BASE_URL: 'https://us-east5-aiplatform.googleapis.com/v1' } })
  await start($)
  expect(await status($)).toContain('vertex · entry TTL 1h (set by cache-warm)')
})

test('a gateway on an Azure VM in front of Foundry is a gateway', { options: AUTO }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  world(on, { envSets, env: { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: 'https://litellm.eastus.cloudapp.azure.com' } })
  await start($)
  expect(envSets.length).toBe(0)
  expect(await status($)).toContain('gateway ·')
})

const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

const NO_USAGE = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }

test('a fork that never reached the API costs nothing, whatever else spent', { options: { ...OPTS, mode: 'off' } }, async ($, on) => {
  const clock = world(on, {
    spend: 0.005, // a background agent, during the ping
    fork: () => ({ isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: NO_USAGE }),
  })
  await start($)
  await turn($, clock)
  await status($, 'ping')
  expect(await status($)).toContain('session: 0 pings, $0.00 spent')
})

test('/cachewarm ping force never warms the conversation from before a compaction', { options: { ...OPTS, mode: 'off' } }, async ($, on) => {
  const forks = { n: 0 }
  const clock = world(on, { forks })
  await start($)
  await turn($, clock)
  await $.session.compact({ trigger: 'manual', messages: SUMMARY })
  expect(await status($, 'ping force')).toContain('the conversation was compacted')
  expect(forks.n).toBe(0)
})

test('a turn cut off before its first request keeps the idle period and its spend', { options: OPTS }, async ($, on) => {
  const clock = world(on, { settings: { promptCacheTtl: '5m' }, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  await turn($, clock)
  await clock.advance(9 * MIN) // pings at 4m and 8m
  expect(await status($)).toContain('this idle period: 2 pings')
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'answer' })
  await clock.settle()
  expect(await status($)).toContain('this idle period: 2 pings')
})

test('/cachewarm on refuses an idle period whose TTL moved', { options: OPTS }, async ($, on) => {
  const clock = world(on)
  await start($)
  await turn($, clock)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100 }], changed: ['rateLimits'] })
  expect(await status($, 'on')).toContain('Not warming this idle period: the cache TTL moved from 1h to 5m')
})

test('a forced rewrite starts an idle period in the TTL it went out in', { options: { ...OPTS, mode: 'off' } }, async ($, on) => {
  const w: World = { fork: () => ({ isAnswered: true, text: '.', usage: usage(0, PREFIX) }) }
  const clock = world(on, w)
  await start($)
  await turn($, clock)
  w.rateLimits = [{ kind: 'five_hour', percentUsed: 100 }]
  await $.session.measure({ context: { window: 200_000 }, rateLimits: w.rateLimits, changed: ['rateLimits'] })
  await clock.advance(61 * MIN)
  expect(await status($, 'ping force')).toContain('MISS (write)')
  expect(await status($, 'on')).not.toContain('Not warming')
  expect(await status($)).toContain('then every 4m')
})

test('an explicit forceTtl wins over the TTL on record', { options: { ...OPTS, forceTtl: '5m' } }, async ($, on) => {
  const envSets: [string, string | undefined][] = []
  const store = { 'ttl:s1': { ttl: '1h', at: 1_000_000 } }
  world(on, { envSets, store, answered: true, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  expect(envSets).toEqual([
    ['CLAUDE_CODE_PROMPT_CACHE_TTL', '5m'],
    ['CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', '5m'],
  ])
})

test('/cachewarm off is kept for a reload even while nothing is warming', { options: OPTS }, async ($, on) => {
  const kept: KeptState[] = []
  on('state.set', (_, e, next) => {
    const w = e as { key: string; value: unknown }
    if (w.key === 'keep') kept.push(w.value as KeptState)
    return next(e)
  })
  const clock = world(on)
  await start($)
  await status($, 'off')
  await clock.settle()
  expect(kept.at(-1)?.overrideMode).toBe('off')
})

test("a reload from 0.6 keeps the session's pause", { options: OPTS }, async ($, on) => {
  const clock = world(on)
  seedState(on, { view: (now) => ({ ...keptView(now, 'paused'), paused: 'two idle periods spent on pings without a warm return' }) }, clock)
  await start($)
  expect(await status($)).toContain('PAUSED: two idle periods')
})

test('a record that failed to write is written at the next turn', { options: AUTO }, async ($, on) => {
  const store: Record<string, unknown> = {}
  const clock = world(on, { store, storeFails: { n: 1 }, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  await turn($, clock)
  expect(store['ttl:s1']).toBeUndefined()
  await turn($, clock)
  expect(store['ttl:s1']).toEqual({ ttl: '1h', at: clock.now() })
})

test('expired records are dropped at most once a day', { options: AUTO }, async ($, on) => {
  const old = { ttl: '1h', at: 1_000_000 - 31 * 24 * 60 * MIN }
  const store: Record<string, unknown> = { 'ttl:old': old }
  const clock = world(on, { store, env: { ANTHROPIC_API_KEY: 'k' } })
  await start($)
  await turn($, clock)
  expect(store['ttl:old']).toBeUndefined()
  store['ttl:older'] = old
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await turn($, clock)
  expect(store['ttl:older']).toEqual(old)
})

test('an idle compaction is skipped while warming; one near the threshold runs', { options: OPTS }, async ($, on) => {
  const compacted: string[] = []
  const w: World = { compacted }
  const clock = world(on, w)
  await start($)
  await turn($, clock)
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  expect(compacted.length).toBe(0)
  // A compaction window well under the model's: 50k of a 60k threshold is for room.
  w.context = { tokens: PREFIX, window: 200_000, percent: 25, breakdown: { autoCompactThreshold: 60_000 } }
  await $.session.compact({ trigger: 'auto', messages: SUMMARY })
  expect(compacted.length).toBe(1)
})

test('a TTL learned on a request is the TTL its idle period is warmed in', { options: { ...OPTS, mode: 'off' } }, async ($, on) => {
  const clock = world(on, { env: { ANTHROPIC_API_KEY: 'k' }, step: () => usage(PREFIX, 4) })
  await start($)
  await turn($, clock)
  await clock.advance(20 * MIN)
  await turn($, clock) // a hit after 20 minutes: a 1h entry
  expect(await status($)).toContain('entry TTL 1h (observed: a hit after a 20m gap)')
  expect(await status($, 'on')).not.toContain('Not warming')
})
