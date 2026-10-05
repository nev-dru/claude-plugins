declare module 'claude-code' {
  interface PluginState {
    ctx: {
      pointers: number
      lookups: number
      shown: string
      index: string
      compacted: boolean
      last: string
      cwd: string
      feed: string
      inplay: string
      files: string
      health: string
      queries: string
      turns: number
      compactions: number
      primed: boolean
      srcUse: string
      lastRemote: number
    }
  }
}
