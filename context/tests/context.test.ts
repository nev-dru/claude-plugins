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
  const ui = await $.ui.mount({ plugin: 'context', component: 'Pane', requestId: 'ctx', surface: 'terminal',
    viewport: { columns: 100, rows: 30 },
    props: { title: 'ctx', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: /ctx lookups: 1/ })).toBeDefined()
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
