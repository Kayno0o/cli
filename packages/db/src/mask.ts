import { isSecretName } from '@kaynooo/cli-kit'

export const MASK = '***'

const EMAIL = /e[-_]?mail/i
const PHONE = /phone|mobile|msisdn|^tel(?:_|$)|_tel$/i
// Match credential/password hashes specifically, never content/commit/file/geo hashes.
const PASSWORD_HASH = /(?:^|[_-])(?:pass(?:word|wd)?|pwd|pin|secret|token|otp|recovery|backup|salted)[_-]?hash|^hash(?:ed)?[_-]?(?:pass|pwd|secret|token)|^password_digest$/i
const JSON_TEXT = /^\s*[[{]/

const SENSITIVE: [string, (name: string) => boolean][] = [
  ['email', name => EMAIL.test(name)],
  ['phone', name => PHONE.test(name)],
  // The definition ev and redact use, except that a bare `key` column (a settings table's) is left alone.
  ['secret', name => name.toLowerCase() !== 'key' && isSecretName(name)],
  ['password', name => PASSWORD_HASH.test(name)],
]

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi

// What a column holds that is masked by default, from its name.
export function sensitiveKind(column: string): string | undefined {
  return SENSITIVE.find(([, matches]) => matches(column))?.[0]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  const prototype = typeof value === 'object' && value !== null ? Object.getPrototypeOf(value) : undefined

  return prototype === Object.prototype || prototype === null
}

// Masks the sensitive keys of a JSON value at any depth, noting the dotted path of each one in `found`.
function maskNested(value: unknown, path: string, found: Set<string>, unmask?: ReadonlySet<string>): unknown {
  if (Array.isArray(value))
    return value.map(item => maskNested(item, path, found, unmask))

  if (!isPlainObject(value))
    return value

  return Object.fromEntries(Object.entries(value).map(([key, inner]) => {
    const dotted = `${path}.${key}`

    if (inner === null || sensitiveKind(key) === undefined || unmask?.has(key.toLowerCase()) === true || unmask?.has(dotted.toLowerCase()) === true)
      return [key, maskNested(inner, dotted, found, unmask)]

    found.add(dotted)

    return [key, MASK]
  }))
}

// A JSON column is read as an object, and a text column holding JSON is parsed to be masked and put back as text.
function maskJson(value: unknown, column: string, found: Set<string>, unmask?: ReadonlySet<string>): unknown {
  if (typeof value !== 'string' || !JSON_TEXT.test(value))
    return maskNested(value, column, found, unmask)

  try {
    const before = found.size
    const masked = maskNested(JSON.parse(value), column, found, unmask)

    return found.size === before ? value : JSON.stringify(masked)
  }
  catch {
    return value
  }
}

export function maskRows(rows: Record<string, unknown>[], raw: boolean, unmask?: ReadonlySet<string>): { rows: Record<string, unknown>[], masked: string[] } {
  if (raw)
    return { rows, masked: [] }

  const columns = Object.keys(rows[0] ?? {}).filter(column => sensitiveKind(column) !== undefined && unmask?.has(column.toLowerCase()) !== true)
  const nested = new Set<string>()

  const masked = rows.map(row => Object.fromEntries(Object.entries(row).map(([column, value]) => {
    if (columns.includes(column))
      return [column, value === null ? value : MASK]

    if (unmask?.has(column.toLowerCase()) === true)
      return [column, value]

    return [column, maskJson(value, column, nested, unmask)]
  })))

  return nested.size === 0 && columns.length === 0 ? { rows, masked: [] } : { rows: masked, masked: [...columns, ...nested] }
}

// Removes the connection URL, its password and any scheme://user:password@ pair from text about to be printed.
export function scrub(text: string, url: string | undefined): string {
  let clean = text

  if (url !== undefined && url !== '') {
    clean = clean.replaceAll(url, '<url>')

    for (const secret of secrets(url))
      clean = clean.replaceAll(secret, MASK)
  }

  return clean.replace(URL_CREDENTIALS, '$1<credentials>@')
}

function secrets(url: string): string[] {
  try {
    const { password, username } = new URL(url)

    return [...new Set([password, decode(password), decode(username)].filter(secret => secret.length > 3))]
  }
  catch {
    return []
  }
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  }
  catch {
    return text
  }
}
