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
test('pane renders with empty state', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Feed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no activity yet/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /MEMORY\.md 12\/60/ })).toBeDefined()
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
