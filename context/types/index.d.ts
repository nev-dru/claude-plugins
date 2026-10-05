declare module 'claude-code' {
  interface PluginState {
    context: {
      pointers: number
      lookups: number
      shown: string
      index: string
      compacted: boolean
      last: string
    }
  }
}
