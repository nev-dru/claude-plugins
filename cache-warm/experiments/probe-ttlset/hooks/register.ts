import type { Register, EngineInterface } from 'claude-code'

async function probe($: EngineInterface): Promise<void> {
  const out = await $.env.get('CW_PROBE_OUT')
  if (!out) return
  const t0 = await $.clock.now()
  const r = await $.model.fork({ prompt: 'Reply with exactly one character: "."' })
  const t1 = await $.clock.now()
  const row = 'usage' in r ? { t0, ms: t1 - t0, isAnswered: r.isAnswered, ...r.usage } : { t0, ms: t1 - t0, reason: r.reason }
  const prev = (await $.fs.exists(out)) ? await $.fs.read(out) : ''
  await $.fs.write(out, prev + JSON.stringify(row) + '\n')
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const want = await $.env.get('CW_PROBE_SET_TTL')
    if (want) {
      const a = await $.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', want)
      const b = await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', want)
      const out = await $.env.get('CW_PROBE_OUT')
      if (out) await $.fs.write(out, JSON.stringify({ set: want, main: a, sub: b }) + '\n')
    }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await probe($)
    return result
  })
}
