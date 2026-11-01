// `text` is the piece as written, `command` the same less its heredoc bodies, which are data and never commands; `separator` is what ends it (`|`, `&&`, `;`, a newline...), empty for the last; `expanded` holds the bodies of its unquoted heredocs, where the shell still runs `$(...)`.
export interface Piece { text: string, start: number, end: number, command: string, separator: string, expanded: string }
export interface Invocation { program: string, args: string[], assignments: string[], isWrapped: boolean }

const SEPARATORS = new Set(['\n', ';', '|'])
const PLAIN_BREAKERS = new Set(['<', '>', '(', ')', '&', '|'])
const WHITESPACE = /\s/
const ASSIGNMENT = /^\w+=/
const TRAILING_SLASHES = /\/+$/
const LEADING_TILDE = /^~(?=\/|$)/
const LEADING_TABS = /^\t+/
const OPENERS = /^[({]+/
const CLOSERS = /[)}]+$/
const DOUBLE_QUOTED_ESCAPES = new Set(['$', '`', '"', '\\'])
const HEREDOC = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()-][^\s;&|<>()]*))/
// Programs that run the command following them, which is the one that counts.
const WRAPPERS = new Set(['command', 'env', 'sudo', 'exec', 'nohup', 'time'])

// A lone `&` sends the command before it to the background, unless it belongs to a redirection such as `2>&1` or `&>`.
function separatorWidth(command: string, i: number): number {
  const pair = command.slice(i, i + 2)

  if (pair === '&&' || pair === '||')
    return 2

  const char = command[i] ?? ''

  if (char === '&')
    return command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>' ? 0 : 1

  return SEPARATORS.has(char) ? 1 : 0
}

// Where the heredocs opened on a line end: from the newline closing that line to the end of the last delimiter line.
function heredocEnd(command: string, newline: number, words: readonly { word: string, stripsTabs: boolean }[]): number {
  let lineStart = newline + 1

  for (const { word, stripsTabs } of words) {
    while (lineStart <= command.length) {
      const next = command.indexOf('\n', lineStart)
      const lineEnd = next === -1 ? command.length : next
      const line = command.slice(lineStart, lineEnd)

      lineStart = lineEnd + 1

      if ((stripsTabs ? line.replace(LEADING_TABS, '') : line) === word)
        break
    }
  }

  return Math.min(lineStart - 1, command.length)
}

function withoutRanges(command: string, start: number, end: number, ranges: readonly [number, number][]): string {
  let text = ''
  let at = start

  for (const [from, to] of ranges) {
    if (to <= start || from >= end)
      continue

    text += command.slice(at, Math.max(at, from))
    at = Math.max(at, to)
  }

  return text + command.slice(at, end)
}

// Splits on the shell separators outside quotes and heredocs, so the `;` and `|` of an inline script stay in its piece, each piece keeping where it sits in the command.
export function splitCommand(command: string): Piece[] {
  const bounds: [number, number, string][] = []
  const bodies: [number, number, boolean][] = []
  let heredocs: { word: string, stripsTabs: boolean, isQuoted: boolean }[] = []
  let start = 0
  let quote: string | null = null

  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''

    if (char === '\\' && quote !== '\'') {
      i++

      continue
    }

    if (quote !== null) {
      if (char === quote)
        quote = null

      continue
    }

    if (char === '\'' || char === '"') {
      quote = char

      continue
    }

    const heredoc = char === '<' && command[i + 1] === '<' && command[i + 2] !== '<' ? HEREDOC.exec(command.slice(i)) : null

    if (heredoc) {
      heredocs.push({ word: heredoc[2] ?? heredoc[3] ?? heredoc[4] ?? '', stripsTabs: heredoc[1] === '-', isQuoted: heredoc[4] === undefined })
      i += heredoc[0].length - 1

      continue
    }

    if (char === '\n' && heredocs.length > 0) {
      const end = heredocEnd(command, i, heredocs)

      bodies.push([i, end, heredocs.some(each => !each.isQuoted)])
      heredocs = []
      i = end - 1

      continue
    }

    const width = separatorWidth(command, i)

    if (width === 0)
      continue

    bounds.push([start, i, command.slice(i, i + width)])
    i += width - 1
    start = i + 1
  }
  bounds.push([start, command.length, ''])

  const ranges = bodies.map(([from, to]): [number, number] => [from, to])

  return bounds.map(([from, to, separator]) => ({
    text: command.slice(from, to),
    start: from,
    end: to,
    command: withoutRanges(command, from, to, ranges),
    separator,
    expanded: bodies.filter(([body, , expands]) => expands && body >= from && body < to).map(([body, bodyEnd]) => command.slice(body, bodyEnd)).join(''),
  }))
}

// True when the text holds no redirect, substitution, subshell or group outside single quotes, and closes every quote it opens.
export function isPlain(text: string): boolean {
  let quote: string | null = null

  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    const isSubstitution = char === '`' || (char === '$' && text[i + 1] === '(')

    if (char === '\\' && quote !== '\'')
      i++
    else if (quote !== null && char === quote)
      quote = null
    else if (quote === null && (char === '"' || char === '\''))
      quote = char
    else if (quote !== '\'' && (isSubstitution || (quote === null && PLAIN_BREAKERS.has(char))))
      return false
  }

  return quote === null
}

// The index of the `)` closing the `(` at `open`, past nested parentheses and quotes; the text's end when it never closes.
function closingParen(text: string, open: number): number {
  let depth = 0
  let quote: string | null = null

  for (let i = open; i < text.length; i++) {
    const char = text[i] ?? ''

    if (char === '\\' && quote !== '\'') {
      i++
    }
    else if (quote !== null) {
      if (char === quote)
        quote = null
    }
    else if (char === '\'' || char === '"') {
      quote = char
    }
    else if (char === '(') {
      depth++
    }
    else if (char === ')' && --depth === 0) {
      return i
    }
  }

  return text.length
}

// The index of the backquote closing the one at `open`, past escaped characters; the text's end when it never closes.
function closingBackquote(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\')
      i++
    else if (text[i] === '`')
      return i
  }

  return text.length
}

// The bodies of the outermost `$(...)` and backquotes; quotes only count where `isQuoting`, as a heredoc body holds them as plain text.
function bodies(text: string, isQuoting: boolean): string[] {
  const found: string[] = []
  let quote: string | null = null

  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''

    if (quote === '\'') {
      if (char === '\'')
        quote = null
    }
    else if (char === '\\') {
      i++
    }
    else if (char === '$' && text[i + 1] === '(') {
      const end = closingParen(text, i + 1)

      found.push(text.slice(i + 2, end))
      i = end
    }
    else if (char === '`') {
      const end = closingBackquote(text, i)

      found.push(text.slice(i + 1, end))
      i = end
    }
    else if (isQuoting && char === '"') {
      quote = quote === null ? char : null
    }
    else if (isQuoting && char === '\'' && quote === null) {
      quote = char
    }
  }

  return found
}

// The commands each piece runs through `$(...)` or backquotes, inside double quotes and unquoted heredoc bodies too; a nested one is found by reading each result in turn.
export function substitutions(command: string): string[] {
  return splitCommand(command).flatMap(piece => [...bodies(piece.command, true), ...bodies(piece.expanded, false)])
}

// A word as the shell would pass it; `isProse` when a quoted part of it holds whitespace, a message or a pattern rather than a path.
export interface Word { text: string, isProse: boolean }

// The words of a piece, quotes and line continuations removed.
export function words(text: string): Word[] {
  const found: Word[] = []
  let current = ''
  let isStarted = false
  let isProse = false
  let quote: string | null = null

  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    const isContinuation = char === '\\' && quote !== '\'' && text[i + 1] === '\n'

    if (isContinuation)
      i++

    if (quote === null && (isContinuation || WHITESPACE.test(char))) {
      if (isStarted)
        found.push({ text: current, isProse })

      current = ''
      isStarted = false
      isProse = false

      continue
    }

    if (isContinuation)
      continue

    isStarted = true

    // within double quotes a backslash escapes only `$`, a backtick, `"` and itself, and stays before anything else (`"v\d"`)
    if (char === '\\' && quote === '"' && !DOUBLE_QUOTED_ESCAPES.has(text[i + 1] ?? ''))
      current += char
    else if (char === '\\' && quote !== '\'')
      current += text[++i] ?? ''
    else if (quote !== null && char === quote)
      quote = null
    else if (quote === null && (char === '"' || char === '\''))
      quote = char
    else
      current += char

    isProse ||= quote !== null && WHITESPACE.test(char)
  }

  if (isStarted)
    found.push({ text: current, isProse })

  return found
}

// The words of a piece as the shell would pass them, quotes and line continuations removed.
export function tokenize(text: string): string[] {
  return words(text).map(word => word.text)
}

// The program a piece runs, by its base name, past any subshell opener, variable assignment or wrapper such as `env` or `sudo`.
export function parseCommand(text: string): Invocation {
  const tokens = tokenize(text)
  const assignments: string[] = []
  let isWrapped = false

  for (;;) {
    const first = tokens[0] ?? ''

    if (OPENERS.test(first)) {
      isWrapped = true
      const rest = first.replace(OPENERS, '')

      if (rest === '')
        tokens.shift()
      else tokens[0] = rest
    }
    else if (ASSIGNMENT.test(first)) {
      assignments.push(tokens.shift() ?? '')
    }
    else if (WRAPPERS.has(first)) {
      isWrapped = true
      tokens.shift()

      while (tokens[0]?.startsWith('-')) tokens.shift()
    }
    else {
      break
    }
  }
  // the closing of a subshell or a group, `(git stash)` or `{ cd x && npm i; }`, ends the last word; a closer inside quotes (`-e "f(g(x))"`) is the word's own
  const closers = CLOSERS.exec(text.trimEnd())?.[0].length ?? 0
  const word = tokens.at(-1) ?? ''
  const trimmed = word.length - (CLOSERS.exec(word)?.[0].length ?? 0)
  const last = word.slice(0, Math.max(trimmed, word.length - closers))

  if (tokens.length > 0)
    tokens.splice(-1, 1, ...(last === '' ? [] : [last]))

  const [program = '', ...args] = tokens

  return { program: program.split('/').pop() ?? '', args, assignments, isWrapped }
}

// Swaps each piece's text for its replacement, keeping the separators between them.
export function replacePieces(command: string, replacements: ReadonlyMap<Piece, string>): string {
  let result = command

  for (const [piece, text] of [...replacements].sort(([a], [b]) => b.start - a.start)) {
    result = result.slice(0, piece.start) + text + result.slice(piece.end)
  }

  return result
}

export function parentDir(path: string): string {
  const cut = path.replace(TRAILING_SLASHES, '').lastIndexOf('/')

  return cut <= 0 ? '/' : path.slice(0, cut)
}

// Resolves a shell path argument against a directory, `~` included, `.` and `..` folded.
export function resolvePath(base: string, arg: string, home: string): string {
  const expanded = arg.replace(LEADING_TILDE, home)
  const parts: string[] = []

  for (const part of (expanded.startsWith('/') ? expanded : `${base}/${expanded}`).split('/')) {
    if (part === '..')
      parts.pop()
    else if (part !== '' && part !== '.')
      parts.push(part)
  }

  return `/${parts.join('/')}`
}
