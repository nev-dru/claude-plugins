export type Ttl = '5m' | '1h'
export type Phase = 'none' | 'turn' | 'warming' | 'warm' | 'cold' | 'paused'
// Why the next request sends a prefix nothing cached, or '' when it doesn't.
export type ColdPrefix = '' | 'compacted' | 'model'

// What the band draws: a snapshot the hooks publish, plus `now` so countdowns tick.
export type CacheView = {
  now: number
  phase: Phase
  ttl: Ttl // the main conversation's TTL: what a turn writes
  ttlSource: string
  refreshTtl: Ttl // what a ping buys
  liveTtl: Ttl // the TTL the current entry got
  provider: string
  model: string
  prefixTokens: number
  lastRequestAt: number // the cache's TTL runs from here (the request's start)
  nextPingAt: number
  stopAt: number
  mode: string
  marginMs: number // how long before expiry a ping is sent; grows with observed latency
  rttMs: number // the slowest ping round-trip seen this session
  paused: string // why automatic warming is paused or held, or ''
  // session totals (survive hot reloads)
  pings: number
  spent: number // USD, API-equivalent on a subscription
  saved: number // USD realized: a return whose first request hit a cache only pings kept warm
  spentPct: number // subscription: five-hour window points spent on pings
  returnsWarm: number // idle periods longer than the TTL that still came back warm
  returnsCold: number
  misses: number
  writes: number // pings that rewrote the prefix instead of reading it
}

// The session's state a reload of the module would otherwise lose, by the
// names the module's own state uses. Written only when it changes.
export type KeptState = {
  coldPrefix: ColdPrefix // the next request writes a prefix nothing cached (a compaction, a model switch)
  idleNote: string // why warming is not running this idle period
  idleTtl: Ttl // the TTL mode this idle period's entry was written in
  idleStartAt: number // this idle period and its guard counters
  idlePings: number
  idleAutoPings: number
  idleWrites: number
  idleErrors: number
  idleSpent: number
  idleSpentPct: number
  overrideMode?: 'auto' | 'manual' | 'off' // /cachewarm overrides
  overrideInterval?: number
  overrideDuration?: number
  mainWrites: number // guardrail counters and the pause
  consecutiveLosses: number
  firstPingWrites: number
  paused: string
  forcedTtl: '' | Ttl // the TTL the mod set at session start
  lastRequestTtl: Ttl // the TTL mode the last main-thread request went out in
  observed?: { ttl: Ttl; source: string } // a TTL learned from the API
}

declare module 'claude-code' {
  interface PluginState {
    'cache-warm': { view: CacheView | null; hidden: boolean; keep: KeptState | null }
  }
}
