import { expect, test } from 'claude-code/testing'

const POINTER = '[01J9ZK3Q7R8M2V5X1B4N6D8F0A] Billing retries are not idempotent → ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0A'

// The prompt.submit stub stands in for Claude Code at the end of the hook chain; it records the
// event it receives so the test can read the context the mod added.
test('prompt naming a file gets a route pointer in context', async ($, on) => {
  let seen
  const argv0 = []
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    argv0.push(e.argv[0])
    if (e.argv[1] === 'route') return { value: { exitCode: 0, stdout: POINTER + '\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: 'index: abc-1\n', stderr: '' } }
  })
  on('prompt.submit', ($, e) => { seen = e; return { text: e.text } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'fix the retry loop in src/pay/client.go' })
  expect((seen.context ?? []).join('\n')).toContain(POINTER)
  // The mod runs the plugin's own shim, not whatever `ctx` is on PATH (the mod's process has no plugin bin on PATH).
  for (const a of argv0) expect(a).toMatch(/\/bin\/ctx$/)
})

test('prompt without signals passes through', async ($, on) => {
  let seen, spawned = 0
  on('process.run', () => { spawned += 1; return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('prompt.submit', ($, e) => { seen = e; return { text: e.text } })
  await $.prompt.submit({ text: 'what time is it' })
  expect(seen.context ?? []).toEqual([])
  expect(spawned).toBe(0)
})

test('jira key adds a howto hint without spawning ctx', async ($, on) => {
  let seen, spawned = 0
  on('process.run', () => { spawned += 1; return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('prompt.submit', ($, e) => { seen = e; return { text: e.text } })
  await $.prompt.submit({ text: 'look at PAY-812 and tell me the status' })
  expect((seen.context ?? []).join('\n')).toMatch(/ctx howto jira/)
  expect(spawned).toBe(0)
})

test('/ctx explain returns text and /ctx opens a pane', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'ctx report: 0 calls\n', stderr: '' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const explain = await $.command.run({ command: 'ctx', args: 'explain' })
  expect(explain.text).toContain('ctx report')
  const pane = await $.command.run({ command: 'ctx', args: '' })
  expect(pane.text).toBeUndefined()
})

test('ctx lookups in Bash commands are counted', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'index: abc-1\n', stderr: '' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ctx search "python version"' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Read', file_path: 'README.md' })
  const ui = await $.ui.mount({ plugin: 'ctx', component: 'Pane', requestId: 'ctx', surface: 'terminal',
    viewport: { columns: 100, rows: 30 },
    props: { title: 'ctx', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: /search "python version" → nothing/ })).toBeDefined() // the stub returned no cards
  await ui.unmount()
})

test('SHA-256 and UTF-8 do not trigger the Jira hint', async ($, on) => {
  let seen
  on('prompt.submit', ($, e) => { seen = e; return { text: e.text } })
  await $.prompt.submit({ text: 'compute the SHA-256 of the UTF-8 bytes and compare with RFC-7231' })
  expect(seen.context ?? []).toEqual([])
})

test('absolute paths under the session cwd are routed relative to it', async ($, on) => {
  const argv = []
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', ($, e) => { argv.push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'look at /work/src/pay/client.go please' })
  const routeCall = argv.find((a) => a[1] === 'route')
  expect(routeCall).toBeDefined()
  expect(routeCall.slice(3)).toEqual(['src/pay/client.go'])
})

// ---- live view signals (Task 2) ----
const SEARCH_OUT = '[01J9ZK3Q7R8M2V5X1B4N6D8F0A] Billing retries are not idempotent  (gotcha · payments-api · 2026-09-14)\nRetrying POST /charges can double-charge. Always pass Idempotency-Key.\n'
const GET_OUT = SEARCH_OUT + 'Contents: Why, Do\n\n## Do\nPass the Idempotency-Key header on every POST /charges.\n'
const PANE = { plugin: 'ctx', component: 'Pane', requestId: 'ctx', surface: 'terminal', viewport: { columns: 120, rows: 40 },
  props: { title: 'ctx', isFocused: true, bodyColumns: 48, placement: 'side', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

function stubs(on, argv) {
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    argv.push(e.argv)
    const sub = e.argv[1]
    if (sub === 'status') return { value: { exitCode: 0, stdout: '{"build_id":"b1","doc_count":20,"index_age_days":2,"review_due":1,"memory_lines":12}\n', stderr: '' } }
    if (sub === 'route') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    return { value: { exitCode: 0, stdout: 'index: b1\n', stderr: '' } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

test('search then get marks the entry found then used, and an Edit reusing its term reports reused', async ($, on) => {
  const argv = []
  stubs(on, argv)
  on('tool.call', ($, e) => ({ result: e.tool === 'Bash' && /ctx get/.test(e.command) ? GET_OUT : e.tool === 'Bash' ? SEARCH_OUT : 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ctx search "double charge on retry"' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0A' })
  await $.tool.call({ tool: 'Edit', file_path: 'src/pay/client.go', old_string: 'x', new_string: 'req.Header.Set("Idempotency-Key", key)' })
  const fb = argv.find((a) => a[1] === 'feedback')
  expect(fb.slice(2, 4)).toEqual(['01J9ZK3Q7R8M2V5X1B4N6D8F0A', 'reused'])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Billing retries are not idempotent/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ reused/ })).toBeDefined()
  await ui.unmount()
})

test('common words do not count as reuse', async ($, on) => {
  const argv = []
  stubs(on, argv)
  on('tool.call', ($, e) => ({ result: e.tool === 'Bash' ? GET_OUT : 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0A' })
  await $.tool.call({ tool: 'Write', file_path: 'notes.md', content: 'the default version of the header is fine' })
  expect(argv.find((a) => a[1] === 'feedback')).toBeUndefined()
})

test('failing command sharing a used term reports suspect; one without terms marks nothing', async ($, on) => {
  const argv = []
  stubs(on, argv)
  on('tool.call', ($, e) => {
    if (e.tool !== 'Bash') return { result: 'ok' }
    if (/ctx get/.test(e.command)) return { result: GET_OUT }
    if (/Idempotency-Key/.test(e.command)) return { result: 'Exit code 1\ncurl: (22) The requested URL returned error: 400' }
    return { result: 'Exit code 1\nmake: *** No rule to make target' }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0A' })
  await $.tool.call({ tool: 'Bash', command: 'make test' })
  expect(argv.find((a) => a[1] === 'feedback')).toBeUndefined()
  await $.tool.call({ tool: 'Bash', command: 'curl -H "Idempotency-Key: 1" https://x/charges' })
  const fb = argv.find((a) => a[1] === 'feedback')
  expect(fb.slice(2, 4)).toEqual(['01J9ZK3Q7R8M2V5X1B4N6D8F0A', 'suspect'])
})

test('reading a file lists it and asks ctx route for pointers', async ($, on) => {
  const argv = []
  stubs(on, argv)
  on('tool.call', () => ({ result: 'file contents' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Read', file_path: '/work/packages/core/cache.py' })
  const route = argv.find((a) => a[1] === 'route')
  expect(route.slice(3)).toEqual(['packages/core/cache.py'])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /packages\/core\/cache\.py/ })).toBeDefined()
  await ui.unmount()
})


// ---- pane and band (Task 3) ----
test('pane renders with empty state and hides empty sections', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /no activity yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /nothing yet|none yet|In play|Files read|Health/ })).toBeUndefined()
  await ui.unmount()
})

test('pane shows the layer strip from ctx status', async ($, on) => {
  const argv = []
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: e.argv[1] === 'status'
    ? '{"build_id":"729b50cabc","active":15,"scopes":{"rufalo":7},"index_age_days":0,"review_due":0,"memory_lines":4,"l1_tokens":3666,"l2_rules":6,"sources":[{"name":"claude-docs","tier":"personal","description":"docs","command":"vex"}]}\n'
    : 'index: 729b50cabc\n', stderr: '' } }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Read', file_path: '/work/a.py' })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ctx · index 729b50c · 0d · 15 entries · review due 0$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /L1 3\.7k · L2 6 rules · L3 0 used\/0 found · L5 claude-docs 0 · L6 MEMORY 4\/60 · L7 1 file/ })).toBeDefined()
  await ui.unmount()
})

test('repeated feed events collapse into one line with a count', async ($, on) => {
  const argv = []
  stubs(on, argv)
  on('tool.call', () => ({ result: SEARCH_OUT }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0A' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0A' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0A' })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /get 8F0A ×3$/ })).toBeDefined()
  await ui.unmount()
})

test('pane shows health from ctx status and the band shows the lessons nudge after five turns with a lookup', async ($, on) => {
  const argv = []
  stubs(on, argv)
  on('tool.call', () => ({ result: SEARCH_OUT }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['other band'] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ctx search "retries"' })
  for (let i = 0; i < 5; i++) await $.prompt.submit({ text: 'turn ' + i })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /MEMORY 12\/60/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /review due 1/ })).toBeDefined()
  await ui.unmount()
  const band = await $.ui.mount({ plugin: 'ctx', component: 'AbovePrompt', requestId: 'One instance', surface: 'terminal',
    viewport: { columns: 120, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } })
  expect(await band.find({ type: 'Text', text: /lessons\? \/ctx:promote/ })).toBeDefined()
  await band.unmount()
})

test('/ctx close closes the pane', async ($, on) => {
  const calls = []
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{}', stderr: '' } }))
  on('ui.close', ($, e) => { calls.push(e); return { value: undefined } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const r = await $.command.run({ command: 'ctx', args: 'close' })
  expect(r.text).toBeUndefined()
  expect(calls.length).toBe(1)
})

// ---- fix pass ----
test('a read-only probe that exits 1 does not mark the entry suspect', async ($, on) => {
  const argv = []
  stubs(on, argv)
  on('tool.call', ($, e) => {
    if (e.tool !== 'Bash') return { result: 'ok' }
    if (/ctx get/.test(e.command)) return { result: GET_OUT }
    return { result: 'Exit code 1' }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0A' })
  await $.tool.call({ tool: 'Bash', command: 'grep -rn "Idempotency-Key" src/' })
  expect(argv.find((a) => a[1] === 'feedback')).toBeUndefined()
})

test('other ctx commands are lookups or nothing, never reuse', async ($, on) => {
  const argv = []
  stubs(on, argv)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['other band'] }))
  on('tool.call', ($, e) => ({ result: e.tool === 'Bash' && /ctx get/.test(e.command) ? GET_OUT : 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0A' })
  await $.tool.call({ tool: 'Bash', command: 'ctx feedback 01J9ZK3Q7R8M2V5X1B4N6D8F0A wrong --note "Idempotency-Key rejected with 400"' })
  await $.tool.call({ tool: 'Bash', command: 'ctx related 01J9ZK3Q7R8M2V5X1B4N6D8F0A' })
  expect(argv.find((a) => a[1] === 'feedback')).toBeUndefined()
  const band = await $.ui.mount({ plugin: 'ctx', component: 'AbovePrompt', requestId: 'One instance', surface: 'terminal',
    viewport: { columns: 120, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } })
  expect(await band.find({ type: 'Text', text: /used 1/ })).toBeDefined()
  await band.unmount()
})

test('ctx get with flags before the id marks the id, and a failed get marks nothing', async ($, on) => {
  const argv = []
  stubs(on, argv)
  on('tool.call', ($, e) => {
    if (e.tool !== 'Bash') return { result: 'ok' }
    if (/ctx get --section/.test(e.command)) return { result: GET_OUT }
    return { result: 'ctx: no entry XXXX' }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get --section Do 01J9ZK3Q7R8M2V5X1B4N6D8F0A' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get XXXX' })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /used +8F0A/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /--section/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /XXXX/ })).toBeUndefined()
  await ui.unmount()
})

test('every used entry whose term appears is marked reused, not only the first', async ($, on) => {
  const argv = []
  stubs(on, argv)
  const GET_C = '[01J9ZK3Q7R8M2V5X1B4N6D8F0C] Retries use exponential backoff  (convention · payments-api · 2026-09-20)\nAlso send Idempotency-Key.\n'
  on('tool.call', ($, e) => {
    if (e.tool !== 'Bash') return { result: 'ok' }
    return { result: /F0C/.test(e.command) ? GET_C : GET_OUT }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0A' })
  await $.tool.call({ tool: 'Bash', command: 'ctx get 01J9ZK3Q7R8M2V5X1B4N6D8F0C' })
  await $.tool.call({ tool: 'Edit', file_path: 'x.go', old_string: 'a', new_string: 'h.Set("Idempotency-Key", k)' })
  const ids = argv.filter((a) => a[1] === 'feedback').map((a) => a[2]).sort()
  expect(ids).toEqual(['01J9ZK3Q7R8M2V5X1B4N6D8F0A', '01J9ZK3Q7R8M2V5X1B4N6D8F0C'])
})

test('reading the same file twice routes once', async ($, on) => {
  const argv = []
  stubs(on, argv)
  on('tool.call', () => ({ result: 'file contents' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Read', file_path: '/work/packages/core/cache.py' })
  await $.tool.call({ tool: 'Read', file_path: '/work/packages/core/cache.py' })
  expect(argv.filter((a) => a[1] === 'route').length).toBe(1)
})

// ---- session pointer: installing the plugin is enough for the model to know the hub exists ----
const STATUS = '{"build_id":"b1","doc_count":20,"active":15,"scopes":{"rufalo":7,"agents":2,"core":2},"index_age_days":0,"review_due":0,"memory_lines":3}\n'
function statusStubs(on, argv) {
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    argv.push(e.argv)
    if (e.argv[1] === 'status') return { value: { exitCode: 0, stdout: STATUS, stderr: '' } }
    return { value: { exitCode: 0, stdout: e.argv[1] === 'sync' ? 'index: b1\n' : '', stderr: '' } }
  })
}

test('the first prompt of a session carries the hub pointer; later prompts do not', async ($, on) => {
  const argv = [], seen = []
  statusStubs(on, argv)
  on('prompt.submit', ($, e) => { seen.push(e); return { text: e.text } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'hello' })
  await $.prompt.submit({ text: 'and again' })
  const first = (seen[0].context ?? []).join('\n')
  expect(first).toMatch(/Team knowledge hub \(ctx\): 15 active entries/)
  expect(first).toMatch(/rufalo 7, agents 2, core 2/)
  expect(first).toMatch(/ctx list/)
  expect(first).toMatch(/ctx search/)
  expect((seen[1].context ?? []).join('\n')).not.toMatch(/Team knowledge hub/)
})

// Re-priming after compaction (session.compact resets `primed`) is not covered here: the test kit treats
// $.session.compact as the API call and offers no way to fire the event.

test('no index means no pointer', async ($, on) => {
  const seen = []
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: e.argv[1] === 'status' ? '{"error":"no index found"}\n' : '', stderr: '' } }))
  on('prompt.submit', ($, e) => { seen.push(e); return { text: e.text } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'hello' })
  expect((seen[0].context ?? []).join('\n')).not.toMatch(/Team knowledge hub/)
})

test('a question about our context, conventions or instructions adds a search hint', async ($, on) => {
  const argv = [], seen = []
  statusStubs(on, argv)
  on('prompt.submit', ($, e) => { seen.push(e); return { text: e.text } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'hello' })
  await $.prompt.submit({ text: 'what do we have in the context hub right now?' })
  await $.prompt.submit({ text: 'what are our conventions for tracing?' })
  await $.prompt.submit({ text: 'fix the typo in line 3' })
  expect((seen[1].context ?? []).join('\n')).toMatch(/ctx list|ctx search/)
  expect((seen[2].context ?? []).join('\n')).toMatch(/ctx search/)
  expect(seen[3].context ?? []).toEqual([])
})

// ---- L5 sources ----
const STATUS_SRC = '{"build_id":"b1","active":15,"scopes":{"rufalo":7},"memory_lines":3,"sources":[' +
  '{"name":"claude-docs","tier":"personal","description":"Claude Code and Anthropic docs (local vex index). Use for how Claude Code works.","command":"vex","match":"anthropic-sdlc-docs"},' +
  '{"name":"max-docs","tier":"personal","description":"Max/MSP reference.","command":"vex","match":"vex search"},' +
  '{"name":"jira","tier":"team","description":"Work tracking.","command":"acli"}]}\n'
function srcStubs(on, argv) {
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    argv.push(e.argv)
    if (e.argv[1] === 'status') return { value: { exitCode: 0, stdout: STATUS_SRC, stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
}

test('the session pointer lists the other sources available on this machine', async ($, on) => {
  const argv = [], seen = []
  srcStubs(on, argv)
  on('prompt.submit', ($, e) => { seen.push(e); return { text: e.text } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: 'hello' })
  const ctx = (seen[0].context ?? []).join('\n')
  expect(ctx).toMatch(/claude-docs \(personal\) — Claude Code and Anthropic docs \(local vex index\)\. Use for how Claude Code works;/)
  expect(ctx).toMatch(/jira \(team\) — Work tracking\. Run `ctx howto/)
  expect(ctx).toMatch(/ctx howto <name>/)
})

test('querying a source is recorded as used and shown in the pane', async ($, on) => {
  const argv = []
  srcStubs(on, argv)
  on('tool.call', () => ({ result: '0.91 a1b2 /docs/mods.md:1-20  Mods' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Bash', command: "vex --db ~/dev/anthropic-sdlc-docs/.vex.db search 'how do mods render a pane'" })
  await $.tool.call({ tool: 'Bash', command: "vex search 'cycle~ object'" })
  await $.tool.call({ tool: 'Bash', command: 'ls vex-notes/' })
  const used = argv.filter((a) => a[1] === 'feedback').map((a) => a.slice(2, 4).join(' '))
  expect(used).toEqual(['source:claude-docs used', 'source:max-docs used'])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /claude-docs 1/ })).toBeDefined()
  await ui.unmount()
})
