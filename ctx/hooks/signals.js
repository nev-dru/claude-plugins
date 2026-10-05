// Pure helpers for the ctx mod's usage signals. No Claude Code API here, so they test in isolation.
const CARD_RE = /^\[([0-9A-HJKMNP-TV-Z]{26})\] (.+?)(?:  \(|$)/gm

// Cards as `ctx search` / `ctx get` print them: `[ULID] title  (kind · scope · date)`.
export function parseCards(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(CARD_RE)) out.push({ id: m[1], title: m[2].trim() })
  return out
}

// Terms worth matching later: identifier-shaped tokens only — paths, env vars, flags, snake_case,
// kebab-case, CamelCase, or names carrying a digit. Ordinary words of any length never count as
// evidence that an entry was applied, and every term must contain a letter.
export function distinctiveTerms(text) {
  const seen = new Set()
  for (const raw of String(text ?? '').split(/[\s,;:()\[\]{}"'`<>]+/)) {
    const t = raw.replace(/^[.\-/<>=]+|[.\-/]+$/g, '')
    if (t.length < 3 || seen.has(t) || !/[A-Za-z]/.test(t)) continue
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(t)) continue // entry ids are not evidence of reuse
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

// A Bash tool result that reports failure (non-zero exit, missing command, error or traceback at line start).
export function isFailure(resultText) {
  const t = String(resultText ?? '')
  return /^Exit code [1-9]/m.test(t) || /command not found/.test(t) || /^Error:/m.test(t) || /^Traceback \(most recent call last\)/m.test(t)
}

export function normalizeQuery(q) {
  return String(q ?? '').replace(/["']/g, '').trim().toLowerCase().replace(/\s+/g, ' ')
}
