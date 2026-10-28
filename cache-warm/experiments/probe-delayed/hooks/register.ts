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
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const delay = Number((await $.env.get('CW_PROBE_DELAY_MS')) ?? '0')
    if (delay > 0) {
      $.clock.after(delay, () => {
        void probe($)
      })
    } else {
      await probe($)
    }
    return result
  })
}
