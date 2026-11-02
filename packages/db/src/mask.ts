import { isSecretName } from '@kaynooo/cli-kit'

export const MASK = '***'

const EMAIL = /e[-_]?mail/i
const PHONE = /phone|mobile|msisdn|^tel(?:_|$)|_tel$/i
const HASH = /hash/i
const JSON_TEXT = /^\s*[[{]/

const SENSITIVE: [string, (name: string) => boolean][] = [
  ['email', name => EMAIL.test(name)],
  ['phone', name => PHONE.test(name)],
  // The definition ev and redact use, except that a bare `key` column (a settings table's) is left alone.
  ['secret', name => name.toLowerCase() !== 'key' && isSecretName(name)],
  ['password', name => HASH.test(name)],
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
function maskNested(value: unknown, path: string, found: Set<string>): unknown {
  if (Array.isArray(value))
    return value.map(item => maskNested(item, path, found))

  if (!isPlainObject(value))
    return value

  return Object.fromEntries(Object.entries(value).map(([key, inner]) => {
    if (inner === null || sensitiveKind(key) === undefined)
      return [key, maskNested(inner, `${path}.${key}`, found)]

    found.add(`${path}.${key}`)

    return [key, MASK]
  }))
}

// A JSON column is read as an object, and a text column holding JSON is parsed to be masked and put back as text.
function maskJson(value: unknown, column: string, found: Set<string>): unknown {
  if (typeof value !== 'string' || !JSON_TEXT.test(value))
    return maskNested(value, column, found)

  try {
    const before = found.size
    const masked = maskNested(JSON.parse(value), column, found)

    return found.size === before ? value : JSON.stringify(masked)
  }
  catch {
    return value
  }
}

export function maskRows(rows: Record<string, unknown>[], raw: boolean): { rows: Record<string, unknown>[], masked: string[] } {
  if (raw)
    return { rows, masked: [] }

  const columns = Object.keys(rows[0] ?? {}).filter(column => sensitiveKind(column) !== undefined)
  const nested = new Set<string>()

  const masked = rows.map(row => Object.fromEntries(Object.entries(row).map(([column, value]) => {
    if (columns.includes(column))
      return [column, value === null ? value : MASK]

    return [column, maskJson(value, column, nested)]
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
