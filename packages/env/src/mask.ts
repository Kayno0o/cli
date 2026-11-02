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

// A URL split into authority, path and query, each with its offsets (flag d).
const URL_PARTS = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#'"<>`]*)([^\s?#'"<>`]*)(?:\?([^\s#'"<>`]*))?/dgi
const PATH_SEGMENT = /[^/]+/g
const QUERY_PARAM = /([^&=]+)=([^&]*)/g
const SECRET_PARAM = /^(?:token|[a-z]+_token|key|api[_-]?key|access[_-]?key|secret|[a-z]+_secret|password|passwd|pwd|sig|signature|auth|authorization)$/i

// Webhook and ping URLs whose last path segment is the secret, whatever the key holding the URL is named.
const WEBHOOK_FORMATS: [kind: string, pattern: RegExp][] = [
  ['Discord webhook', /(?:^|\.)discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/([\w-]+)/di],
  ['Slack webhook', /^hooks\.slack\.com\/(?:services|workflows)\/(?:[\w-]+\/)*([\w-]+)/di],
  ['Uptime Kuma push URL', /\/api\/push\/([\w-]+)/di],
  ['healthchecks.io ping URL', /^hc-ping\.com\/([\w-]+)/di],
]

// A path segment that looks like a token: at least 20 characters of [A-Za-z0-9_-] mixing lowercase, uppercase and digits, or at least 32 alphanumerics mixing letters and digits (hex, base32, dashless UUIDs). Plain slugs, dates and words never do.
const OPAQUE_SEGMENT = /^(?:(?=[\w-]{20,}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[\w-]+|(?=[A-Za-z\d]{32,}$)(?=.*[A-Za-z])(?=.*\d).+)$/

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

// The tokens a URL carries outside its password: the secret of a known webhook format, an opaque path segment and the value of a token-like query parameter.
function urlTokens(line: string): Match[] {
  const found: Match[] = []
  const add = (kind: string, start: number, value: string): void => {
    found.push({ start, end: start + value.length, kind, mask: hint(value) })
  }

  for (const url of line.matchAll(URL_PARTS)) {
    const [authority, path = '', query] = [url[1] ?? '', url[2] ?? '', url[3]]
    const authorityStart = url.indices?.[1]?.[0]
    const pathStart = url.indices?.[2]?.[0]
    const queryStart = url.indices?.[3]?.[0]

    if (authorityStart === undefined || pathStart === undefined)
      continue

    const hostAt = authority.lastIndexOf('@') + 1
    const target = authority.slice(hostAt) + path

    for (const [kind, pattern] of WEBHOOK_FORMATS) {
      const [start, end] = pattern.exec(target)?.indices?.[1] ?? []

      if (start !== undefined && end !== undefined)
        add(kind, authorityStart + hostAt + start, target.slice(start, end))
    }

    for (const segment of path.matchAll(PATH_SEGMENT)) {
      if (OPAQUE_SEGMENT.test(segment[0]))
        add('URL token', pathStart + segment.index, segment[0])
    }

    if (query === undefined || queryStart === undefined)
      continue

    for (const param of query.matchAll(QUERY_PARAM)) {
      const [name, value] = [param[1] ?? '', param[2] ?? '']

      if (value !== '' && SECRET_PARAM.test(name))
        add('URL token', queryStart + param.index + name.length + 1, value)
    }
  }

  return found.filter(match => match.end > match.start)
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

  found.push(...urlTokens(line))

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
