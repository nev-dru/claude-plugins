export type Ttl = '5m' | '1h'
export type Phase = 'none' | 'turn' | 'warming' | 'warm' | 'cold'

// What the band draws: a snapshot the hooks publish, plus `now` so countdowns tick.
export type CacheView = {
  now: number
  phase: Phase
  ttl: Ttl
  ttlSource: string
  provider: string
  model: string
  prefixTokens: number
  lastRequestAt: number // the cache's TTL runs from here
  nextPingAt: number
  stopAt: number
  mode: string
  // this idle period
  idlePings: number
  idleSpent: number
  // session totals (survive hot reloads)
  pings: number
  spent: number // USD, API-equivalent on a subscription
  saved: number // USD realized: a return whose first request hit a cache only pings kept warm
  spentPct: number // subscription: five-hour window points spent on pings
  returnsWarm: number // idle periods longer than the TTL that still came back warm
  returnsCold: number
  misses: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-warm': { view: CacheView | null; hidden: boolean }
  }
}
