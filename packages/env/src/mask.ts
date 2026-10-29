export interface Match {
  start: number
  end: number
  kind: string
  // What replaces the span: a hint of the secret, or `***` for a URL password.
  mask: string
}

// Secret values taken from .env files: the regex finds them whole in a line, `keys` says which key each belongs to.
export interface KnownSecrets {
  pattern: RegExp | undefined
  keys: Map<string, string>
}

// A value shorter than this is not masked when found loose in output, too many false hits.
export const MIN_KNOWN_LENGTH = 6

const SECRET_KEY = /TOKEN|SECRET|PASSWORD|KEY|PRIVATE|DSN/i
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:([^\s@/]+)@/dgi
const ESCAPE = /[.*+?^${}()|[\]\\]/g

const TOKEN_FORMATS: [kind: string, pattern: RegExp][] = [
  ['GitHub token', /\b(?:gh[pousr]_|github_pat_)\w{20,}/g],
  ['GitLab token', /\bglpat-[\w-]{20,}/g],
  ['API key', /\bsk-[\w-]{20,}/g],
  ['Slack token', /\bxox[abprs]-[\w-]{10,}/g],
  ['JWT', /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g],
]

export const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
export const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key)
}

// A few leading characters and the length, so two values can be told apart without leaking either.
export function hint(value: string): string {
  const shown = Math.min(3, Math.floor(value.length / 4))

  return `${value.slice(0, shown)}***(${value.length})`
}

export function knownSecrets(pairs: Iterable<readonly [key: string, value: string]>): KnownSecrets {
  const keys = new Map<string, string>()

  for (const [key, value] of pairs) {
    if (value.length >= MIN_KNOWN_LENGTH && !keys.has(value))
      keys.set(value, key)
  }

  if (keys.size === 0)
    return { pattern: undefined, keys }

  const alternatives = [...keys.keys()].sort((a, b) => b.length - a.length).map(value => value.replace(ESCAPE, '\\$&'))

  return { pattern: new RegExp(`(?<!\\w)(?:${alternatives.join('|')})(?!\\w)`, 'g'), keys }
}

export function urlPasswords(text: string): string[] {
  return [...text.matchAll(URL_PASSWORD)].flatMap(url => url[1] ?? [])
}

// Every secret in one line, longest first where spans overlap.
export function findSecrets(line: string, known?: KnownSecrets): Match[] {
  const found: Match[] = []

  for (const url of line.matchAll(URL_PASSWORD)) {
    const [start, end] = url.indices?.[1] ?? []

    if (start !== undefined && end !== undefined)
      found.push({ start, end, kind: 'URL password', mask: '***' })
  }

  for (const [kind, pattern] of TOKEN_FORMATS) {
    for (const token of line.matchAll(pattern))
      found.push({ start: token.index, end: token.index + token[0].length, kind, mask: hint(token[0]) })
  }

  if (known?.pattern !== undefined) {
    for (const value of line.matchAll(known.pattern))
      found.push({ start: value.index, end: value.index + value[0].length, kind: `value of ${known.keys.get(value[0])}`, mask: hint(value[0]) })
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end)

  const kept: Match[] = []

  for (const match of found) {
    if (match.start >= (kept.at(-1)?.end ?? 0))
      kept.push(match)
  }

  return kept
}

export function maskLine(line: string, known?: KnownSecrets): string {
  let out = ''
  let at = 0

  for (const match of findSecrets(line, known)) {
    out += line.slice(at, match.start) + match.mask
    at = match.end
  }

  return out + line.slice(at)
}

// A value shown by ev: wholly masked under a secret-looking key or when it is a private key, else only the secrets inside it.
export function maskValue(key: string, value: string): string {
  if (value === '')
    return value

  return isSecretKey(key) || PEM_BEGIN.test(value) ? hint(value) : maskLine(value)
}
