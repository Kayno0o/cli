// One logical line of a .env file: a comment, a blank or an unparsed line (no key), or an assignment whose raw text may span several physical lines.
export interface DotenvLine {
  raw: string
  key?: string
  value?: string
}

export interface Dotenv {
  lines: DotenvLine[]
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Z_][\w.-]*)\s*=(.*)$/i
const EXPORTED = /^\s*export\s/
const INLINE_COMMENT = /\s+#.*$/
const CARRIAGE_RETURN = /\r$/
const ESCAPES: Record<string, string> = { 'n': '\n', 'r': '\r', 't': '\t', '"': '"', '\\': '\\', '$': '$' }

export const LINE_BREAK = /[\r\n]/
// Bun does not unescape these inside double quotes, so a value holding one is written in single quotes.
const RAW_ONLY = /["\\]/
const NEEDS_QUOTES = /[\s#"'\\$`]/

// Finds the closing quote, skipping backslash escapes inside double quotes. Returns -1 when the value continues on the next line.
function closingQuote(text: string, quote: string): number {
  for (let index = 0; index < text.length; index++) {
    if (quote === '"' && text[index] === '\\')
      index++
    else if (text[index] === quote)
      return index
  }

  return -1
}

// Bun reads `\$` as a literal dollar sign in every quoting, and expands a bare `$` even inside single quotes.
function unescapeDollar(text: string): string {
  return text.replaceAll('\\$', '$')
}

function unescapeDouble(text: string): string {
  let out = ''

  for (let index = 0; index < text.length; index++) {
    const next = text[index + 1]

    if (text[index] === '\\' && next !== undefined && next in ESCAPES) {
      out += ESCAPES[next]
      index++
    }
    else {
      out += text[index]
    }
  }

  return out
}

export function parseDotenv(text: string): Dotenv {
  const physical = text.split('\n')
  const lines: DotenvLine[] = []

  for (let index = 0; index < physical.length; index++) {
    const line = physical[index] ?? ''
    const match = ASSIGNMENT.exec(line.replace(CARRIAGE_RETURN, ''))

    if (match === null) {
      lines.push({ raw: line })

      continue
    }

    const [, key = '', rest = ''] = match
    const start = rest.trimStart()
    const quote = start[0]

    if (quote !== '"' && quote !== '\'' && quote !== '`') {
      lines.push({ raw: line, key, value: unescapeDollar(start.replace(INLINE_COMMENT, '').trim()) })

      continue
    }

    let body = start.slice(1)
    let raw = line
    let end = closingQuote(body, quote)

    while (end === -1 && index + 1 < physical.length) {
      index++
      body += `\n${(physical[index] ?? '').replace(CARRIAGE_RETURN, '')}`
      raw += `\n${physical[index] ?? ''}`
      end = closingQuote(body, quote)
    }

    const inner = end === -1 ? body : body.slice(0, end)

    lines.push({ raw, key, value: quote === '"' ? unescapeDouble(inner) : unescapeDollar(inner) })
  }

  return { lines }
}

export function serializeDotenv(file: Dotenv): string {
  return file.lines.map(line => line.raw).join('\n')
}

// The effective entries: a repeated key keeps its last value, as dotenv loaders do.
export function entries(file: Dotenv): Map<string, string> {
  const map = new Map<string, string>()

  for (const line of file.lines) {
    if (line.key !== undefined)
      map.set(line.key, line.value ?? '')
  }

  return map
}

// A value written between double quotes, each `$` escaped because Bun expands it in every quoting.
export function escapeDouble(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('$', '\\$')
}

export function formatAssignment(key: string, value: string): string {
  if (value === '' || !NEEDS_QUOTES.test(value))
    return `${key}=${value}`

  // Bun expands a bare `$` in every quoting, so each one is written as `\$`.
  if (RAW_ONLY.test(value) && !value.includes('\'') && !LINE_BREAK.test(value))
    return `${key}='${value.replaceAll('$', '\\$')}'`

  return `${key}="${escapeDouble(value)}"`
}

// Replaces the last assignment of a key keeping its `export`, or appends before the trailing newline. `raw` is the whole line to store when given.
export function setLine(file: Dotenv, key: string, value: string, raw?: string): void {
  const index = file.lines.findLastIndex(line => line.key === key)
  const existing = file.lines[index]

  if (existing !== undefined) {
    const exported = EXPORTED.test(existing.raw) ? 'export ' : ''

    file.lines[index] = { raw: raw ?? `${exported}${formatAssignment(key, value)}`, key, value }

    return
  }

  const line = { raw: raw ?? formatAssignment(key, value), key, value }
  const last = file.lines.at(-1)

  if (last === undefined)
    file.lines.push(line, { raw: '' })
  else if (last.raw === '')
    file.lines.splice(-1, 0, line)
  else
    file.lines.push(line, { raw: '' })
}

// Drops every assignment of the key and returns how many went.
export function removeKey(file: Dotenv, key: string): number {
  const before = file.lines.length

  file.lines = file.lines.filter(line => line.key !== key)

  return before - file.lines.length
}

export function lastLine(file: Dotenv, key: string): DotenvLine | undefined {
  return file.lines.findLast(line => line.key === key)
}
