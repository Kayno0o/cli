// One logical line of a .env file: a comment, a blank or an unparsed line (no key), or an assignment whose raw text may span several physical lines.
export interface DotenvLine {
  raw: string
  key?: string
  value?: string
  // The value opens a quote that no line closes before the next assignment: it is read as the rest of its own line, as Bun does.
  unterminated?: boolean
}

export interface Dotenv {
  lines: DotenvLine[]
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Z_][\w.-]*)\s*=(.*)$/i
const EXPORTED = /^\s*export\s/
const INLINE_COMMENT = /\s+#.*$/
const CARRIAGE_RETURN = /\r$/
const CARRIAGE_RETURNS = /\r$/gm
const COMMENT_AFTER_QUOTE = /\s*#.*$/
const ESCAPES: Record<string, string> = { 'n': '\n', 'r': '\r', 't': '\t', '"': '"', '\\': '\\', '$': '$' }

export const LINE_BREAK = /[\r\n]/
// What neither Bun's --env-file nor compose's env_file reads specially.
const PLAIN = /^[^\s#"'\\$`]+$/
// What single quotes cannot hold for both: Bun expands `$` in them, compose reads `\'` as a quote, and a carriage return would be written raw.
const NOT_SINGLE = /['$\r]|\\$/
// Both read \n, \r and \$ in double quotes, but each reads \", \\ and the other escapes its own way.
const NOT_DOUBLE = /["\\]/
// A bare value: Bun ends it at any `#`, both expand `$`, trim it and take a leading quote for an opening one.
const NOT_BARE = /[#$\r\n]|^[\s"'`]|\s$/
const UNQUOTABLE = [['$', '$'], ['"', '"'], ['\'', '\''], ['\\', '\\'], ['#', '#'], ['\n', 'a line break'], ['\r', 'a carriage return']] as const

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

    const first = index

    // A quoted value runs to its closing quote whatever the lines between look like, as Bun and compose read it: a PEM body line can look like an assignment.
    while (end === -1 && index + 1 < physical.length) {
      index++
      body += `\n${(physical[index] ?? '').replace(CARRIAGE_RETURN, '')}`
      raw += `\n${physical[index] ?? ''}`
      end = closingQuote(body, quote)
    }

    // With no closing quote anywhere, Bun keeps the line as it is and reads the next ones on their own.
    if (end === -1) {
      index = first
      lines.push({ raw: line, key, value: unescapeDollar(start.replace(INLINE_COMMENT, '').trim()), unterminated: true })

      continue
    }

    const inner = body.slice(0, end)

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

// The assignment Bun's --env-file and compose's env_file both read back as the value: bare when nothing in it is special, else double-quoted, single-quoted or bare, the first form that holds it for both; undefined when none does.
export function formatAssignment(key: string, value: string): string | undefined {
  if (value === '' || PLAIN.test(value))
    return `${key}=${value}`

  if (!NOT_DOUBLE.test(value))
    return `${key}="${value.replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('$', '\\$')}"`

  if (!NOT_SINGLE.test(value))
    return `${key}='${value}'`

  return NOT_BARE.test(value) ? undefined : `${key}=${value}`
}

// Why formatAssignment finds no form for the value: the characters in it that clash.
export function unquotable(value: string): string {
  const held = UNQUOTABLE.filter(([char]) => value.includes(char)).map(([, name]) => name)
  const spaced = value.trim() === value ? [] : ['whitespace at an end']

  return `its value holds ${[...held, ...spaced].join(', ')}, which no quoting lets both Bun's --env-file and compose's env_file read as it is`
}

// The inline comment after an assignment's value, on its last line.
function inlineComment(raw: string): string {
  const lines = raw.replaceAll(CARRIAGE_RETURNS, '').split('\n')
  const value = ASSIGNMENT.exec(lines[0] ?? '')?.[2] ?? ''
  const start = value.trimStart()
  const quote = start[0]

  // An empty value leaves only the comment, whose leading space the trim would take.
  if (quote !== '"' && quote !== '\'' && quote !== '`')
    return INLINE_COMMENT.exec(value)?.[0] ?? ''

  const last = lines.length === 1 ? start.slice(1) : lines.at(-1) ?? ''
  const end = closingQuote(last, quote)

  return end === -1 ? '' : COMMENT_AFTER_QUOTE.exec(last.slice(end + 1))?.[0] ?? ''
}

// The callers refuse an unquotable value first, so reaching this with one is a bug.
function assignment(key: string, value: string): string {
  const line = formatAssignment(key, value)

  if (line === undefined)
    throw new Error(unquotable(value))

  return line
}

// Replaces the last assignment of a key keeping its `export`, inline comment and line ending, or appends before the trailing newline in the file's line ending. `raw` is the whole line to store when given.
export function setLine(file: Dotenv, key: string, value: string, raw?: string): void {
  const index = file.lines.findLastIndex(line => line.key === key)
  const existing = file.lines[index]

  if (existing !== undefined) {
    const exported = EXPORTED.test(existing.raw) ? 'export ' : ''
    const ending = existing.raw.endsWith('\r') ? '\r' : ''
    const line = raw?.replace(CARRIAGE_RETURN, '') ?? `${exported}${assignment(key, value)}${inlineComment(existing.raw)}`

    file.lines[index] = { raw: `${line}${ending}`, key, value }

    return
  }

  const ending = file.lines.some(line => line.raw.endsWith('\r')) ? '\r' : ''
  const line = { raw: `${raw?.replace(CARRIAGE_RETURN, '') ?? assignment(key, value)}${ending}`, key, value }
  const last = file.lines.at(-1)

  if (last === undefined) {
    file.lines.push(line, { raw: '' })
  }
  else if (last.raw === '') {
    file.lines.splice(-1, 0, line)
  }
  else {
    last.raw = `${last.raw.replace(CARRIAGE_RETURN, '')}${ending}`
    file.lines.push(line, { raw: '' })
  }
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
