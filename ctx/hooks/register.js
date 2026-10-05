import { atom, read, update } from 'claude-code'
import { parseCards, distinctiveTerms, findReuse, isFailure, failureNote, isReadOnlyProbe, ctxCommand, firstULID, normalizeQuery } from './signals.js'

// Session counters shown in the band and the /ctx pane. Declared in types/index.d.ts.
const pointers = atom({ plugin: 'ctx', key: 'pointers' }, 0)
const lookups = atom({ plugin: 'ctx', key: 'lookups' }, 0)
const shown = atom({ plugin: 'ctx', key: 'shown' }, '')
const index = atom({ plugin: 'ctx', key: 'index' }, '?')
const compacted = atom({ plugin: 'ctx', key: 'compacted' }, false)
const last = atom({ plugin: 'ctx', key: 'last' }, '')
const cwd = atom({ plugin: 'ctx', key: 'cwd' }, '')
// Live-view model, JSON-encoded: feed lines, entries in play, files read, health, queries seen, turn count.
const feed = atom({ plugin: 'ctx', key: 'feed' }, '[]')
const inplay = atom({ plugin: 'ctx', key: 'inplay' }, '{}')
const files = atom({ plugin: 'ctx', key: 'files' }, '[]')
const health = atom({ plugin: 'ctx', key: 'health' }, '{}')
const queries = atom({ plugin: 'ctx', key: 'queries' }, '[]')
const turns = atom({ plugin: 'ctx', key: 'turns' }, 0)
const compactions = atom({ plugin: 'ctx', key: 'compactions' }, 0)

const FEED_CAP = 40
const INPLAY_CAP = 60
const FILES_CAP = 30

// Deterministic signals in a prompt: a file path, a Jira key, a stack trace.
const PATH_RE = /(?:^|[\s"'`(\[])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]+)/g
// Project keys are letters only; common technical tokens shaped like keys (SHA-256, UTF-8, RFC-7231) are excluded.
const JIRA_RE = /\b(?!(?:UTF|SHA|ISO|RFC|GPT|AES|CVE|MD|HTTP|TLS|RSA|CRC|IEEE|ECMA|RTX|GTX|ARM|X)-)[A-Z][A-Z]{1,9}-\d+\b/
const TRACE_RE = /Traceback \(most recent call last\)|\n\s+at .+\(.+:\d+:\d+\)|panic: /

// Paths named in the prompt, made relative to the session cwd so dragged-in absolute paths still route.
function pathsIn(text, root) {
  const out = new Set()
  for (const m of String(text ?? '').matchAll(PATH_RE)) out.add(relative(m[1], root))
  return [...out].slice(0, 20)
}

function relative(p, root) {
  return root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p
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

// State values are JSON strings; a corrupt value falls back so a render never throws.
// (read() is always called with the atom const itself so the mod scan can list what is read.)
function parseJSON(text, fallback) {
  try {
    const v = JSON.parse(text)
    return v === null || typeof v !== typeof fallback || Array.isArray(v) !== Array.isArray(fallback) ? fallback : v
  } catch {
    return fallback
  }
}

async function writeInplay($, inp) {
  const ids = Object.keys(inp)
  if (ids.length > INPLAY_CAP) for (const id of ids.slice(0, ids.length - INPLAY_CAP)) delete inp[id]
  await update($, inplay, () => JSON.stringify(inp))
}

async function pushFeed($, kind, text) {
  const items = parseJSON(await read($, feed), [])
  const t = new Date().toISOString().slice(11, 16)
  await update($, feed, () => JSON.stringify([{ t, kind, text }, ...items].slice(0, FEED_CAP)))
}

function resultText(result) {
  if (typeof result?.result === 'string') return result.result
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result ?? '')
  } catch {
    return ''
  }
}

function short(id) {
  return id.slice(-4)
}

async function recordFeedback($, id, verdict, note) {
  try {
    await $.process.run([CTX, 'feedback', id, verdict, '--note', note.slice(0, 160)])
  } catch {}
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const root = typeof e.cwd === 'string' ? e.cwd.replace(/\/+$/, '') : ''
    await update($, cwd, () => root)
    try {
      const r = await $.process.run([CTX, 'sync', '--check'])
      const line = r.stdout.trim()
      await update($, index, () => (line.startsWith('index: ') ? line.slice(7) : 'missing'))
    } catch {
      await update($, index, () => 'no ctx')
    }
    try {
      const r = await $.process.run([CTX, 'status', '--json', '--cwd', root])
      const text = r.stdout.trim()
      await update($, health, () => (text.startsWith('{') ? text : '{}'))
    } catch {
      await update($, health, () => '{"error":"ctx unavailable"}')
    }
    try {
      await $.command.register({ name: 'ctx', description: 'Live view of the team context this session uses', argumentHint: '[explain|close]' })
    } catch {}
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, turns, (n) => n + 1)
    const extra = []
    const root = await read($, cwd)
    const named = pathsIn(e.text, root)
    if (named.length > 0) {
      try {
        const r = await $.process.run([CTX, 'route', '--files', ...named])
        if (r.exitCode === 0 && r.stdout.trim() !== '') {
          // Each pointer is injected once per session (reset after compaction).
          const seen = new Set((await read($, shown)).split('\n').filter(Boolean))
          const fresh = r.stdout.trim().split('\n').filter((l) => !seen.has(l))
          if (fresh.length > 0) {
            extra.push('Team knowledge for files named in this prompt (fetch with ctx get):\n' + fresh.join('\n'))
            await update($, shown, () => [...seen, ...fresh].join('\n'))
            await update($, pointers, (n) => n + fresh.length)
            await update($, last, () => fresh.join('\n'))
            const inp = parseJSON(await read($, inplay), {})
            for (const c of parseCards(fresh.join('\n'))) if (!inp[c.id]) inp[c.id] = { title: c.title, how: 'offered', reused: false, suspect: false, terms: [] }
            await writeInplay($, inp)
            await pushFeed($, 'pointer', 'pointer ×' + fresh.length + ' ← ' + named.slice(0, 2).join(', ') + (named.length > 2 ? ' …' : ''))
            $.ui.invalidate('ui.render')
          }
        }
      } catch {}
    }
    // Deterministic source hints (spec §4): a Jira key or a stack trace names a source or a search; no process is spawned.
    if (JIRA_RE.test(e.text)) {
      extra.push('A Jira key appears in this prompt. If a Jira source is declared (`ctx sources`), run `ctx howto jira` for the query syntax, then query Jira directly.')
      await pushFeed($, 'hint', 'hint: Jira key → ctx howto jira')
    }
    if (TRACE_RE.test(e.text)) {
      extra.push('A stack trace appears in this prompt. Search team knowledge with the exact error string: `ctx search "<error string>"`.')
      await pushFeed($, 'hint', 'hint: stack trace → ctx search "<error>"')
    }
    if (extra.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...extra] })
  })

  // One tool.call hook. Bash `ctx search|get` output is read after the tool runs (await next); other ctx
  // commands are never scored; file reads are listed and routed once; edits and commands are checked for
  // reuse of a fetched entry's terms, and a failing (non-probe) command that used a term marks it suspect.
  on('tool.call', async ($, e, next) => {
    const tool = e.tool
    const cmd = tool === 'Bash' ? String(e.command ?? e.input?.command ?? '') : ''
    const c = tool === 'Bash' ? ctxCommand(cmd) : null
    if (c) {
      if (c.sub === 'related' || c.sub === 'howto') await update($, lookups, (n) => n + 1)
      if (c.sub !== 'search' && c.sub !== 'get') return next(e)
      await update($, lookups, (n) => n + 1)
      const result = await next(e)
      const text = resultText(result)
      const cards = parseCards(text)
      const inp = parseJSON(await read($, inplay), {})
      if (c.sub === 'search') {
        const q = normalizeQuery(c.rest)
        const qs = parseJSON(await read($, queries), [])
        const again = qs.includes(q)
        await update($, queries, () => JSON.stringify([...qs, q].slice(-30)))
        for (const card of cards) {
          const prev = inp[card.id] ?? { reused: false, suspect: false, terms: [] }
          inp[card.id] = { ...prev, title: card.title, how: prev.how === 'used' ? 'used' : 'found' }
        }
        await pushFeed($, 'search', (again ? 're-search ' : 'search ') + JSON.stringify(q) + ' → ' + (cards.map((x) => short(x.id)).join(' ') || 'nothing'))
      } else {
        // A get that printed no card (bad id, no index) marks nothing.
        const id = cards[0]?.id ?? (cards.length ? null : null)
        if (id) {
          const prev = inp[id] ?? { reused: false, suspect: false }
          inp[id] = { ...prev, title: cards[0].title, how: 'used', terms: distinctiveTerms(text) }
          await pushFeed($, 'get', 'get ' + short(id) + (/--section/.test(c.rest) ? ' §' : /--full/.test(c.rest) ? ' (full)' : ''))
        } else {
          await pushFeed($, 'get', 'get ' + (firstULID(c.rest) ? short(firstULID(c.rest)) : '?') + ' → no entry')
        }
      }
      await writeInplay($, inp)
      $.ui.invalidate('ui.render')
      return result
    }
    if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
      const root = await read($, cwd)
      const p = relative(String(e.file_path ?? e.path ?? e.input?.file_path ?? e.input?.path ?? ''), root)
      if (p) {
        const list = parseJSON(await read($, files), [])
        const known = list.find((f) => f && f.path === p)
        let count = known ? known.pointers : 0
        if (!known) {
          try {
            const r = await $.process.run([CTX, 'route', '--files', p])
            const cards = parseCards(r.stdout)
            count = cards.length
            if (count) {
              const inp = parseJSON(await read($, inplay), {})
              for (const card of cards) if (!inp[card.id]) inp[card.id] = { title: card.title, how: 'offered', reused: false, suspect: false, terms: [] }
              await writeInplay($, inp)
            }
          } catch {}
        }
        await update($, files, () => JSON.stringify([{ path: p, pointers: count }, ...list.filter((f) => f && f.path !== p)].slice(0, FILES_CAP)))
        await pushFeed($, 'read', tool.toLowerCase() + ' ' + p + (count ? ' (' + count + ' pointer' + (count > 1 ? 's' : '') + ')' : ''))
        $.ui.invalidate('ui.render')
      }
      return next(e)
    }
    if (tool === 'Edit' || tool === 'Write' || tool === 'Bash') {
      // grep/ls/cat/diff and friends check an entry rather than apply it: neither reuse nor suspect.
      if (tool === 'Bash' && isReadOnlyProbe(cmd)) return next(e)
      const inputText = tool === 'Bash' ? cmd : String(e.new_string ?? e.content ?? e.input?.new_string ?? e.input?.content ?? '')
      const inp = parseJSON(await read($, inplay), {})
      // Every fetched entry whose term appears is credited, so ranking does not depend on fetch order.
      const hits = []
      for (const [id, v] of Object.entries(inp)) {
        if (!v || v.how !== 'used') continue
        const term = findReuse(v.terms, inputText)
        if (term) hits.push({ id, term })
      }
      if (hits.length === 0) return next(e)
      const result = await next(e)
      const text = resultText(result)
      const failed = tool === 'Bash' && isFailure(text)
      const edited = tool !== 'Bash' && isFailure(text) // an Edit whose result reports failure did not apply the entry
      if (edited) return result
      for (const hit of hits) {
        if (failed) {
          inp[hit.id].suspect = true
          const note = failureNote(text)
          await pushFeed($, 'suspect', 'suspect ' + short(hit.id) + ' ← ' + note)
          await recordFeedback($, hit.id, 'suspect', note)
        } else if (!inp[hit.id].reused) {
          inp[hit.id].reused = true
          await pushFeed($, 'reuse', 'reuse ' + short(hit.id) + ' ← ' + hit.term)
          await recordFeedback($, hit.id, 'reused', hit.term + ' in ' + tool)
        }
      }
      await writeInplay($, inp)
      $.ui.invalidate('ui.render')
      return result
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    await update($, compacted, () => true)
    await update($, compactions, (n) => n + 1)
    await update($, shown, () => '')
    await pushFeed($, 'compact', 'compacted')
    return next(e)
  })

  on('command.run', { command: 'ctx' }, async ($, e) => {
    const arg = (e.args || '').trim()
    if (arg === 'explain') {
      try {
        const r = await $.process.run([CTX, 'report', '--session', 'current'])
        return { text: r.stdout.trim() || 'ctx report: no calls this session' }
      } catch (err) {
        return { text: 'ctx report unavailable: ' + String(err) }
      }
    }
    if (arg === 'close') {
      try {
        await $.ui.close({ id: 'ctx' })
      } catch {}
      return {}
    }
    await $.ui.open({ id: 'ctx', title: 'ctx', columns: 48, focus: true, closeOnEscape: true })
    return {}
  })

  // The band: one dim line above the prompt. Other mods' AbovePrompt content is kept (next(e)) and ours is added under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    const p = await read($, pointers)
    const l = await read($, lookups)
    const i = await read($, index)
    const f = (parseJSON(await read($, feed), [])).length
    const used = Object.values(parseJSON(await read($, inplay), {})).filter((v) => v && v.how === 'used').length
    const t = await read($, turns)
    const c = (await read($, compacted)) ? ' · compacted' : ''
    const nudge = t >= 5 && (l >= 1 || p >= 1) ? ' · lessons? /ctx:promote' : ''
    const line = Text({ dimColor: true, wrap: 'truncate', children: ['ctx · pointers ' + p + ' · used ' + used + ' · feed ' + f + ' · index ' + String(i).slice(0, 7) + c + nudge] })
    return Box({ flexDirection: 'column', children: [theirs, line] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'ctx') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const rows = e.props?.scroll?.bodyRows ?? 30
    const items = parseJSON(await read($, feed), [])
    const inp = parseJSON(await read($, inplay), {})
    const fl = parseJSON(await read($, files), [])
    const h = parseJSON(await read($, health), {})
    const i = await read($, index)
    const nComp = await read($, compactions)
    // wrap: 'truncate' clips to the pane width at draw time; the full text stays in the element.
    const line = (s) => Text({ wrap: 'truncate', children: [String(s)] })
    const dim = (s) => Text({ dimColor: true, wrap: 'truncate', children: [String(s)] })
    const head = (s) => Text({ bold: true, children: [s] })

    const feedRows = Math.max(3, rows - 16)
    const feedLines = items.length ? items.filter(Boolean).slice(0, feedRows).map((x) => dim((x.t ?? '') + ' ' + (x.text ?? ''))) : [dim('no activity yet')]

    const mark = (v) => (v.suspect ? '✗ suspect' : v.reused ? '✓ reused' : v.how)
    const order = { used: 0, found: 1, offered: 2 }
    const inLines = Object.entries(inp)
      .filter(([, v]) => v && typeof v === 'object')
      .sort((a, b) => (order[a[1].how] ?? 3) - (order[b[1].how] ?? 3))
      .slice(0, 8)
      .map(([id, v]) => line(mark(v).padEnd(9) + ' ' + short(id) + ' ' + (v.title || id)))

    const fileLines = fl.filter((f) => f && f.path).slice(0, 5).map((f) => dim(f.path + (f.pointers ? ' (' + f.pointers + ' pointer' + (f.pointers > 1 ? 's' : '') + ')' : '')))

    const healthLines = h.error
      ? [line('index missing · ' + h.error)]
      : [
          line('MEMORY.md ' + (h.memory_lines ?? '?') + '/60 lines'),
          line('index ' + String(i).slice(0, 7) + ' · ' + (h.index_age_days ?? '?') + ' d old · ' + (h.doc_count ?? '?') + ' entries'),
          line('review due ' + (h.review_due ?? 0) + (nComp ? ' · compacted ×' + nComp : '')),
        ]

    return Box({
      flexDirection: 'column',
      children: [
        head('Feed'),
        ...feedLines,
        Text({ children: [' '] }),
        head('In play (' + Object.keys(inp).length + ')'),
        ...(inLines.length ? inLines : [dim('nothing yet')]),
        Text({ children: [' '] }),
        head('Files read (' + fl.length + ')'),
        ...(fileLines.length ? fileLines : [dim('none yet')]),
        Text({ children: [' '] }),
        head('Health'),
        ...healthLines,
        dim('/ctx explain · /ctx close · Esc'),
      ],
    })
  })
}
