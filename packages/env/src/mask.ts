import { isSecretName } from '@kaynooo/cli-kit'

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
export const MIN_KNOWN_LENGTH = 4

export const KEY_MASK = '*** private key redacted ***'
// A value that is a setting rather than a secret, even under a secret-looking key.
const PLAIN_VALUE = /^(?:true|false|null|none|nil|yes|no|on|off|undefined)$/i
const PLACEHOLDER = /^[$%{<(*/]/
const URL_PASSWORD = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]*:([^\s'"]{1,1024})@/dgi
const PORT = /^\d{1,5}$/
const ESCAPE = /[.*+?^${}()|[\]\\]/g

interface TokenFormat {
  kind: string
  pattern: RegExp
  // Skips a candidate that is a placeholder or a plain word. `before` is the line text ahead of it, `name` the key a pattern names `name`.
  skip?: (value: string, before: string, name?: string) => boolean
}

// A secret value starting like this is a reference or a placeholder, not the secret.
function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value) || PLAIN_VALUE.test(value)
}

// Names that are secrets whatever they are followed by, and names that also open prose (`token: expired`, `auth: failed`).
const STRONG_NAME = 'password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|shared[_-]?access[_-]?key'
const WEAK_NAME = 'token|credentials?|auth'
const PLAIN_WORD = /^[a-z]+$/i
const AFTER_COLON = /:\s*$/
const DIGIT = /\d/
const KEY_VALUE_GAP = '\\s*[:=]\\s*'

// A strong name before a colon, so likely prose, holding only a word is left alone.
function isProse(value: string, before: string): boolean {
  return isPlaceholder(value) || (AFTER_COLON.test(before) && PLAIN_WORD.test(value))
}

// A value under a weak name is a secret only when it holds a digit or is long, which a word of prose never does.
function isWeak(value: string, before: string): boolean {
  return isProse(value, before) || !(DIGIT.test(value) || value.length >= 16)
}

// A key name holding one of the words: `AWS_SECRET_ACCESS_KEY`, `X-Api-Key`, `access_token`.
function keyed(names: string, value: string): RegExp {
  return new RegExp(`(?<![\\w-])["']?(?<name>(?:[\\w-]{0,30}[_-])?(?:${names})(?:[_-][\\w-]{0,30})?)["']?${KEY_VALUE_GAP}${value}`, 'dgi')
}

// Any key name, which `isSecretName` then judges, so `PGPASSWORD`, `MYSQL_PWD` and `clientSecret` count as `DB_PASSWORD` does.
const ANY_NAME = '(?<![\\w.-])["\']?(?<name>[a-z_][\\w.-]{0,60})["\']?'
// Names a value under is a secret even when short and without a digit, as under `password`.
const PASSWORD_NAME = new RegExp(`${STRONG_NAME}|pass|pwd`, 'i')
// Name endings of a setting about a secret rather than the secret (`TOKEN_TTL`, `PASSWORD_FILE`).
const SETTING_SUFFIX = /[_.-](?:TTL|FILE|PATH|DIR|NAME|URL|TIMEOUT|EXPIRY|EXPIRES|LIFETIME|LENGTH|ENABLED|ALGORITHM|HEADER|PREFIX|COUNT|MAX|MIN)$/i

const NUMBER = /^\d+$/

// A value under a setting's name, or a count under a weak one (`max_tokens=4096`), is no secret.
function isSetting(value: string, name: string): boolean {
  return SETTING_SUFFIX.test(name) || (!PASSWORD_NAME.test(name) && NUMBER.test(value))
}

// The skip of a key the name alone does not settle: a private key is masked by its own markers.
function isPlainNamed(value: string, before: string, name = ''): boolean {
  if (!isSecretName(name) || isSetting(value, name) || value.length < 4 || value.includes('-----BEGIN '))
    return true

  return PASSWORD_NAME.test(name) ? isProse(value, before) : isWeak(value, before)
}

// A pattern with a group masks that group only, else the whole match.
const TOKEN_FORMATS: TokenFormat[] = [
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_|github_pat_)\w{20,}/dg },
  { kind: 'GitLab token', pattern: /\bgl(?:pat|rt|dt|ptt)-[\w-]{20,}/dg },
  { kind: 'Hugging Face token', pattern: /\bhf_[A-Za-z]{30,}/dg },
  { kind: 'webhook secret', pattern: /\bwhsec_\w{20,}/dg },
  { kind: 'DigitalOcean token', pattern: /\bdop_v1_\w{20,}/dg },
  { kind: 'Shopify token', pattern: /\bshp(?:at|ca|pa|ss)_\w{20,}/dg },
  { kind: 'password', pattern: /\bmysql(?:dump|admin)?\s+(?:\S+\s+)*?-p([^\s"'|;&-]\S{3,})/dg },
  { kind: 'password', pattern: /\bsshpass\s+(?:-[a-oq-z]\s+)*-p\s*([^\s"'|;&]{4,})/dg },
  { kind: 'API key', pattern: /\bsk-[\w-]{20,}/dg },
  { kind: 'Slack token', pattern: /\bx(?:ox[abprs]|app)-[\w-]{10,}/dg },
  { kind: 'JWT', pattern: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/dg },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/dg },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{30,}/dg },
  { kind: 'Stripe key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/dg },
  { kind: 'Google API key', pattern: /\bAIza[\w-]{35}/dg },
  { kind: 'SendGrid key', pattern: /\bSG\.[\w-]{16,}\.[\w-]{16,}/dg },
  { kind: 'Authorization header', pattern: /\bAuthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token|Digest)\s+([^\s"',;]{8,})/dgi, skip: isPlaceholder },
  { kind: 'Bearer token', pattern: /\bBearer\s+((?=[\w.~+/=-]*\d)[\w.~+/=-]{20,})/dg },
  { kind: 'password', pattern: keyed(STRONG_NAME, '([^\\s"\'&;,]{4,})'), skip: (value, before, name = '') => isSetting(value, name) || isProse(value, before) },
  { kind: 'password', pattern: keyed(WEAK_NAME, '([^\\s"\'&;,]{4,})'), skip: (value, before, name = '') => isSetting(value, name) || isWeak(value, before) },
  { kind: 'password', pattern: keyed(STRONG_NAME, '(["\'])((?:\\\\.|(?!\\2)[^\\\\\\n]){4,})\\2'), skip: (value, _, name = '') => isSetting(value, name) || isPlaceholder(value) },
  { kind: 'password', pattern: keyed(WEAK_NAME, '(["\'])((?:\\\\.|(?!\\2)[^\\\\\\n]){4,})\\2'), skip: (value, before, name = '') => isSetting(value, name) || isWeak(value, before) },
  { kind: 'password', pattern: new RegExp(`${ANY_NAME}${KEY_VALUE_GAP}([^\\s"'&;,]{4,})`, 'dgi'), skip: isPlainNamed },
  { kind: 'password', pattern: new RegExp(`${ANY_NAME}${KEY_VALUE_GAP}(["'])((?:\\\\.|(?!\\2)[^\\\\\\n]){4,})\\2`, 'dgi'), skip: isPlainNamed },
  // A variable as printenv or env prints it, whose value runs to the end of the line, spaces included.
  { kind: 'password', pattern: /^\s*(?:export\s+)?(?<name>[A-Za-z_]\w{0,60})=(?!["'])(\S(?:.*\S)?)/dg, skip: isPlainNamed },
]

// A private key block (PEM, PGP). Its body is masked from just after the BEGIN marker to the END marker or the end of the line, so one line may hold the whole key escaped as JSON.
export const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/
export const PEM_END = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/
const PEM_BODY = /(?<=-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----)(?:(?!-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----)[\s\S])+/dg
const PEM_BEGIN_ALL = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g

// A URL split into authority, path and query, each with its offsets (flag d).
const URL_PARTS = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/([^\s/?#'"<>`]*)([^\s?#'"<>`]*)(?:\?([^\s#'"<>`]*))?/dgi
const PATH_SEGMENT = /[^/]+/g
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

export function isSecretKey(key: string): boolean {
  return isSecretName(key)
}

// A few leading characters and the length, so two values can be told apart without leaking either.
export function hint(value: string): string {
  const shown = Math.min(3, Math.floor(value.length / 4))

  return `${value.slice(0, shown)}***(${value.length})`
}

// The forms a value takes in output: as is, percent-encoded and escaped inside a JSON string.
function forms(value: string): string[] {
  return [...new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])]
}

export function knownSecrets(pairs: Iterable<readonly [key: string, value: string]>): KnownSecrets {
  const keys = new Map<string, string>()

  for (const [key, value] of pairs) {
    if (value.length < MIN_KNOWN_LENGTH || PLAIN_VALUE.test(value))
      continue

    for (const form of forms(value)) {
      if (!keys.has(form))
        keys.set(form, key)
    }
  }

  if (keys.size === 0)
    return { pattern: undefined, keys }

  const alternatives = [...keys.keys()].sort((a, b) => b.length - a.length).map(value => value.replace(ESCAPE, '\\$&'))

  return { pattern: new RegExp(`(?<!\\w)(?:${alternatives.join('|')})(?!\\w)`, 'g'), keys }
}

// The password span of each URL in the text. A password may hold `@`, the last one before the host closing it, and `/`, unless only a port precedes the `/` (`host:3000/@scope/pkg`).
function passwordSpans(text: string): [start: number, end: number][] {
  const spans: [number, number][] = []

  for (const url of text.matchAll(URL_PASSWORD)) {
    const [start, end] = url.indices?.[1] ?? []
    const password = url[1] ?? ''
    const slash = password.indexOf('/')

    if (start !== undefined && end !== undefined && !(slash !== -1 && PORT.test(password.slice(0, slash))))
      spans.push([start, end])
  }

  return spans
}

export function urlPasswords(text: string): string[] {
  return passwordSpans(text).map(([start, end]) => text.slice(start, end))
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

    let offset = 0

    // Split rather than matched with a regex, which rescans the rest of a long parameter from every character.
    for (const param of query.split('&')) {
      const equals = param.indexOf('=')

      if (equals > 0 && equals < param.length - 1 && SECRET_PARAM.test(param.slice(0, equals)))
        add('URL token', queryStart + offset + equals + 1, param.slice(equals + 1))

      offset += param.length + 1
    }
  }

  return found.filter(match => match.end > match.start)
}

// Every secret in one line, longest first where spans overlap.
export function findSecrets(line: string, known?: KnownSecrets): Match[] {
  const found: Match[] = []

  for (const [start, end] of passwordSpans(line))
    found.push({ start, end, kind: 'URL password', mask: '***' })

  for (const body of line.matchAll(PEM_BODY)) {
    const [start, end] = body.indices?.[0] ?? []

    if (start !== undefined && end !== undefined)
      found.push({ start, end, kind: 'private key', mask: KEY_MASK })
  }

  for (const { kind, pattern, skip } of TOKEN_FORMATS) {
    for (const token of line.matchAll(pattern)) {
      const [start, end] = token.indices?.at(-1) ?? []

      if (start === undefined || end === undefined)
        continue

      const value = line.slice(start, end)

      if (!skip?.(value, line.slice(0, start), token.groups?.name))
        found.push({ start, end, kind, mask: hint(value) })
    }
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

// When the line opens a private key block it does not close (the last BEGIN marker has no END marker after it), the key text that follows the marker on the line, else undefined.
export function openKeyBody(line: string): string | undefined {
  const last = [...line.matchAll(PEM_BEGIN_ALL)].at(-1)

  if (last === undefined)
    return undefined

  const after = line.slice(last.index + last[0].length)

  return PEM_END.test(after) ? undefined : after.trim()
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

// A value shown by ev: wholly masked under a secret-looking key or when it holds a private key, else only the secrets inside it.
export function maskValue(key: string, value: string, known?: KnownSecrets): string {
  if (value === '')
    return value

  return isSecretName(key) || PEM_BEGIN.test(value) ? hint(value) : maskLine(value, known)
}
