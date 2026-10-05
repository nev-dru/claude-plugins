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
    }
  }
}
