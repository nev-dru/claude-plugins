import { atom, read, update } from 'claude-code'

// Session counters shown in the band and the /ctx pane. Declared in types/index.d.ts.
const pointers = atom({ plugin: 'context', key: 'pointers' }, 0)
const lookups = atom({ plugin: 'context', key: 'lookups' }, 0)
const shown = atom({ plugin: 'context', key: 'shown' }, '')
const index = atom({ plugin: 'context', key: 'index' }, '?')
const compacted = atom({ plugin: 'context', key: 'compacted' }, false)
const last = atom({ plugin: 'context', key: 'last' }, '')
const cwd = atom({ plugin: 'context', key: 'cwd' }, '')

// Deterministic signals in a prompt: a file path, a Jira key, a stack trace.
const PATH_RE = /(?:^|[\s"'`(\[])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]+)/g
// Project keys are letters only; common technical tokens shaped like keys (SHA-256, UTF-8, RFC-7231) are excluded.
const JIRA_RE = /\b(?!(?:UTF|SHA|ISO|RFC|GPT|AES|CVE|MD|HTTP|TLS|RSA|CRC|IEEE|ECMA|RTX|GTX|ARM|X)-)[A-Z][A-Z]{1,9}-\d+\b/
const TRACE_RE = /Traceback \(most recent call last\)|\n\s+at .+\(.+:\d+:\d+\)|panic: /

// Paths named in the prompt, made relative to the session cwd so dragged-in absolute paths still route.
function pathsIn(text, root) {
  const out = new Set()
  for (const m of String(text ?? '').matchAll(PATH_RE)) {
    let p = m[1]
    if (root && p.startsWith(root + '/')) p = p.slice(root.length + 1)
    out.add(p)
  }
  return [...out].slice(0, 20)
}

// The plugin's own shim (bin/ctx), resolved from this module's location: the mod's process does not
// have the plugin bin directory on PATH (only Claude's Bash tool does). Falls back to a bare `ctx`.
function ctxBin() {
  try {
    return decodeURIComponent(new URL('../bin/ctx', import.meta.url).pathname)
  } catch {
    return 'ctx'
  }
}
const CTX = ctxBin()

export function register(on) {
  on('session.start', async ($, e, next) => {
    await update($, cwd, () => (typeof e.cwd === 'string' ? e.cwd.replace(/\/+$/, '') : ''))
    try {
      const r = await $.process.run([CTX, 'sync', '--check'])
      const line = r.stdout.trim()
      await update($, index, () => (line.startsWith('index: ') ? line.slice(7) : 'missing'))
    } catch {
      await update($, index, () => 'no ctx')
    }
    try {
      await $.command.register({ name: 'ctx', description: 'Show what team context this session used', argumentHint: '[explain]' })
    } catch {}
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const extra = []
    const files = pathsIn(e.text, await read($, cwd))
    if (files.length > 0) {
      try {
        const r = await $.process.run([CTX, 'route', '--files', ...files])
        if (r.exitCode === 0 && r.stdout.trim() !== '') {
          // Each pointer is injected once per session (reset after compaction).
          const seen = new Set((await read($, shown)).split('\n').filter(Boolean))
          const fresh = r.stdout.trim().split('\n').filter((l) => !seen.has(l))
          if (fresh.length > 0) {
            extra.push('Team knowledge for files named in this prompt (fetch with ctx get):\n' + fresh.join('\n'))
            await update($, shown, () => [...seen, ...fresh].join('\n'))
            await update($, pointers, (n) => n + fresh.length)
            await update($, last, () => fresh.join('\n'))
            $.ui.invalidate('ui.render')
          }
        }
      } catch {}
    }
    // Deterministic source hints (spec §4): a Jira key or a stack trace names a source or a search; no process is spawned.
    if (JIRA_RE.test(e.text)) extra.push('A Jira key appears in this prompt. If a Jira source is declared (`ctx sources`), run `ctx howto jira` for the query syntax, then query Jira directly.')
    if (TRACE_RE.test(e.text)) extra.push('A stack trace appears in this prompt. Search team knowledge with the exact error string: `ctx search "<error string>"`.')
    if (extra.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...extra] })
  })

  // Count ctx lookups Claude makes through Bash. The tool input may arrive flattened (e.command) or nested (e.input.command).
  on('tool.call', async ($, e, next) => {
    const cmd = e.tool === 'Bash' ? (typeof e.command === 'string' ? e.command : e.input?.command ?? '') : ''
    if (/^\s*ctx\s+(search|get|related|howto)\b/.test(cmd)) {
      await update($, lookups, (n) => n + 1)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    await update($, compacted, () => true)
    await update($, shown, () => '')
    return next(e)
  })

  on('command.run', { command: 'ctx' }, async ($, e) => {
    if ((e.args || '').trim() === 'explain') {
      try {
        const r = await $.process.run([CTX, 'report', '--today'])
        return { text: r.stdout.trim() || 'ctx report: no calls today' }
      } catch (err) {
        return { text: 'ctx report unavailable: ' + String(err) }
      }
    }
    await $.ui.open({ id: 'ctx', title: 'ctx', focus: true, closeOnEscape: true })
    return {}
  })

  // The band: one dim line above the prompt. Other mods' AbovePrompt content is kept (next(e)) and ours is added under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    const p = await read($, pointers)
    const l = await read($, lookups)
    const i = await read($, index)
    const c = (await read($, compacted)) ? ' · compacted' : ''
    const line = Text({ dimColor: true, wrap: 'truncate', children: ['ctx · pointers ' + p + ' · lookups ' + l + ' · index ' + i + c] })
    return Box({ flexDirection: 'column', children: [theirs, line] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'ctx') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const p = await read($, pointers)
    const l = await read($, lookups)
    const i = await read($, index)
    const recent = await read($, last)
    return Box({
      flexDirection: 'column',
      children: [
        Text({ bold: true, children: ['Team context this session'] }),
        Text({ children: ['pointers injected: ' + p + '   ctx lookups: ' + l + '   index: ' + i] }),
        Text({ children: [' '] }),
        Text({ children: ['last pointers:'] }),
        Text({ children: [recent || '(none yet)'] }),
        Text({ children: [' '] }),
        Text({ dimColor: true, children: ["/ctx explain prints today's ctx report into the transcript. Esc closes."] }),
      ],
    })
  })
}
