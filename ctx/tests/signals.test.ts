import { expect, test } from 'claude-code/testing'
import { parseCards, distinctiveTerms, findReuse, isFailure, normalizeQuery } from '../hooks/signals.js'

test('parseCards reads ctx search and get output', async () => {
  const out = '[01J9ZK3Q7R8M2V5X1B4N6D8F0A] Billing retries are not idempotent  (gotcha · payments-api · 2026-09-14)\nRetrying POST /charges…\n\n[01J9ZK3Q7R8M2V5X1B4N6D8F0C] Retries use exponential backoff  (convention · payments-api · 2026-09-20)\n'
  expect(parseCards(out)).toEqual([
    { id: '01J9ZK3Q7R8M2V5X1B4N6D8F0A', title: 'Billing retries are not idempotent' },
    { id: '01J9ZK3Q7R8M2V5X1B4N6D8F0C', title: 'Retries use exponential backoff' },
  ])
})

test('distinctiveTerms keeps identifiers and drops common words', async () => {
  const terms = distinctiveTerms('Always pass Idempotency-Key. RUFALO_REPORT_MARKDOWN is read in docs/ci.md; the default version requires python:3.12 and build_prefix.')
  expect(terms).toContain('Idempotency-Key')
  expect(terms).toContain('RUFALO_REPORT_MARKDOWN')
  expect(terms).toContain('docs/ci.md')
  expect(terms).toContain('build_prefix')
  expect(terms).not.toContain('default')
  expect(terms).not.toContain('version')
  expect(terms).not.toContain('requires')
  // numbers and ordinary long words are not evidence that an entry was applied
  const weak = distinctiveTerms('Python >=3.12,<3.13 is the workspace standard; supported features are documented.')
  expect(weak).not.toContain('3.12')
  expect(weak).not.toContain('>=3.12')
  expect(weak).not.toContain('workspace')
  expect(weak).not.toContain('supported')
  expect(weak).not.toContain('documented')
})

test('findReuse matches a term on a word boundary only', async () => {
  const terms = ['Idempotency-Key', 'build_prefix']
  expect(findReuse(terms, 'headers["Idempotency-Key"] = key')).toBe('Idempotency-Key')
  expect(findReuse(terms, 'call rebuild_prefix_cache()')).toBeNull()
  expect(findReuse(terms, 'nothing here')).toBeNull()
})

test('isFailure recognises Bash tool failures', async () => {
  expect(isFailure('Exit code 1\nError: cannot find module')).toBe(true)
  expect(isFailure('zsh: command not found: ctxx')).toBe(true)
  expect(isFailure('ok\n')).toBe(false)
  expect(isFailure('the word error appears mid-sentence but nothing failed')).toBe(false)
})

test('normalizeQuery folds case, quotes and spacing', async () => {
  expect(normalizeQuery('  "Python  Version" ')).toBe('python version')
})
