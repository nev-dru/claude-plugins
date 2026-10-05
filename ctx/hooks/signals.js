// Pure helpers for the ctx mod's usage signals. No Claude Code API here, so they test in isolation.
const CARD_RE = /^\[([0-9A-HJKMNP-TV-Z]{26})\] (.+?)(?:  \(|\s+→|$)/gm
const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/
// File names present in nearly every repository: seeing one in an edit says nothing about an entry.
const UBIQUITOUS = new Set(['CLAUDE.md', 'AGENTS.md', 'README.md', 'MEMORY.md', 'pyproject.toml', 'package.json', 'package-lock.json',
  'Makefile', 'go.mod', 'go.sum', 'Cargo.toml', 'Dockerfile', 'docker-compose.yml', '.gitignore', '.env', 'tsconfig.json', 'requirements.txt', 'setup.py', 'uv.lock'])
// Commands whose non-zero exit means "not found", not "failed": they never make an entry suspect.
const READ_ONLY = new Set(['grep', 'rg', 'ag', 'ack', 'diff', 'cmp', 'test', '[', '[[', 'find', 'ls', 'cat', 'head', 'tail', 'which', 'type', 'stat', 'wc', 'file', 'tree', 'jq', 'awk', 'sed', 'sort', 'uniq'])

// Cards as `ctx search` / `ctx get` / `ctx route` print them: `[ULID] title  (kind · scope · date)` or `[ULID] title → ctx get ULID`.
export function parseCards(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(CARD_RE)) out.push({ id: m[1], title: m[2].trim() })
  return out
}

// Terms worth matching later: identifier-shaped tokens only — paths, env vars, flags, snake_case,
// kebab-case, CamelCase, or names carrying a digit. Ordinary words of any length never count as
// evidence that an entry was applied, every term must contain a letter, and ubiquitous file names are skipped.
export function distinctiveTerms(text) {
  const seen = new Set()
  for (const raw of String(text ?? '').split(/[\s,;:()\[\]{}"'`<>]+/)) {
    const t = raw.replace(/^[.\-/<>=]+|[.\-/]+$/g, '')
    if (t.length < 3 || seen.has(t) || !/[A-Za-z]/.test(t)) continue
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(t)) continue // entry ids are not evidence of reuse
    if (UBIQUITOUS.has(t) || UBIQUITOUS.has(t.split('/').pop())) continue
    const shaped = /[_\-./]/.test(t) || /\d/.test(t) || /[a-z][A-Z]/.test(t)
    if (shaped) seen.add(t)
    if (seen.size >= 40) break
  }
  return [...seen]
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&')
}

// First term that appears in the text as a whole token (not inside a longer identifier).
export function findReuse(terms, inputText) {
  const text = String(inputText ?? '')
  for (const term of terms ?? []) {
    const re = new RegExp('(?<![A-Za-z0-9_])' + escapeRe(term) + '(?![A-Za-z0-9_])')
    if (re.test(text)) return term
  }
  return null
}

const FAIL_RE = /^Exit code [1-9]\d*\b|command not found/m

// A Bash tool result that reports a non-zero exit. Claude Code prints `Exit code N` at line start for a
// failing command; words like "Error:" inside ordinary output (logs, greps) are not failures.
export function isFailure(resultText) {
  return FAIL_RE.test(String(resultText ?? ''))
}

// The line that reports the failure, for the suspect note.
export function failureNote(resultText) {
  const lines = String(resultText ?? '').split('\n')
  return (lines.find((l) => FAIL_RE.test(l)) || lines.find((l) => l.trim()) || 'failed').trim().slice(0, 120)
}

// grep/diff/test/ls and friends exit non-zero to say "no", which is not evidence against an entry.
export function isReadOnlyProbe(cmd) {
  const words = String(cmd ?? '').trim().split(/\s+/)
  if (words.length === 0) return false
  if (words[0] === 'git' && words[1] === 'grep') return true
  return READ_ONLY.has(words[0])
}

// The first `ctx <sub> …` invocation in a Bash command, cut at a newline, pipe or chain operator.
export function ctxCommand(cmd) {
  const m = /^\s*ctx\s+([a-z-]+)\b([^\n|;&]*)/.exec(String(cmd ?? ''))
  if (!m) return null
  return { sub: m[1], rest: m[2].trim() }
}

export function firstULID(text) {
  const m = ULID_RE.exec(String(text ?? ''))
  return m ? m[0] : null
}

export function normalizeQuery(q) {
  return String(q ?? '').replace(/["']/g, '').trim().toLowerCase().replace(/\s+/g, ' ')
}
