// `text` is the piece as written, `command` the same less its heredoc bodies and comments, which are data and never commands; `separator` is what ends it (`|`, `&&`, `;`, a newline...), empty for the last; `expanded` holds the bodies of its unquoted heredocs, where the shell still runs `$(...)`, and `heredocs` those of all its heredocs.
export interface Piece { text: string, start: number, end: number, command: string, separator: string, expanded: string, heredocs: string[] }
export interface Invocation { program: string, args: string[], assignments: string[], isWrapped: boolean }

const SEPARATORS = new Set(['\n', ';', '|'])
const PLAIN_BREAKERS = new Set(['<', '>', '(', ')', '&', '|'])
const GLOB_CHARS = new Set(['*', '?', '['])
const COMMENT_PREFIXES = new Set([';', '&', '|', '(', ')'])
const WHITESPACE = /\s/
const ASSIGNMENT = /^\w+=/
const TRAILING_SLASHES = /\/+$/
const TRAILING_CR = /\r$/
const LEADING_TILDE = /^~(?=\/|$)/
const LEADING_TABS = /^\t+/
const OPENERS = /^[({]+/
const CLOSERS = /[)}]+$/
const CASE_LABEL = /^\(?[^\s()]*\)$/
const REDIRECT_ONLY = /^\d*(?:<|>|>>|<&|>&|&>|>\||<>)$/
const REDIRECT_START = /^\d*[<>]|^&>/
const SAFE_WORD = /^[\w@%+=:,./-]+$/
const LEADING_HEX = /^[\da-f]*/i
const DOUBLE_QUOTED_ESCAPES = new Set(['$', '`', '"', '\\'])
const HEREDOC = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()-][^\s;&|<>()]*))/
// The quote opened by `$'`, inside which a backslash escapes and decodes.
const ANSI_QUOTE = '$\''
const ANSI_ESCAPES: Record<string, string> = { 'n': '\n', 't': '\t', 'r': '\r', 'a': '\x07', 'b': '\b', 'f': '\f', 'v': '\v', 'e': '\x1B', 'E': '\x1B', '\\': '\\', '\'': '\'', '"': '"', '?': '?' }
const ANSI_DIGITS: Record<string, number> = { x: 2, u: 4, U: 8 }
const OCTAL = /^[0-7]{1,3}/
// Keywords opening a command of a compound statement, which the command following them is the one that counts.
const KEYWORDS = new Set(['then', 'do', 'else', 'if', 'elif', 'while', 'until', '!', '{', '}'])
const MAX_DEPTH = 8
const MAX_BRACES = 256
// Programs reading a command string with `-c`.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh'])
const COMMAND_STRING_PROGRAMS = new Set([...SHELLS, 'su', 'runuser'])
const SHELL_VALUE_OPTIONS = new Set(['-o', '-O', '--rcfile', '--init-file'])
const PRINTERS = new Set(['echo', 'printf'])
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

// Programs that run the command following them, which is the one that counts, with the options taking a value and the operands before that command.
interface WrapperSpec { short: string, long: readonly string[], operands: number }

function wrapper(short = '', long: readonly string[] = [], operands = 0): WrapperSpec {
  return { short, long, operands }
}

const WRAPPERS = new Map<string, WrapperSpec>([
  ['command', wrapper()],
  ['builtin', wrapper()],
  ['nohup', wrapper()],
  ['setsid', wrapper()],
  ['busybox', wrapper()],
  ['exec', wrapper('a')],
  ['time', wrapper('fo', ['--format', '--output'])],
  ['env', wrapper('uCS', ['--unset', '--chdir', '--split-string', '--argv0'])],
  ['sudo', wrapper('ughpCTrtUDR', ['--user', '--group', '--host', '--prompt', '--close-from', '--command-timeout', '--role', '--type', '--other-user', '--chdir', '--chroot'])],
  ['doas', wrapper('uC')],
  ['timeout', wrapper('sk', ['--signal', '--kill-after'], 1)],
  ['nice', wrapper('n', ['--adjustment'])],
  ['ionice', wrapper('cnpPu', ['--class', '--classdata', '--pid', '--pgid', '--uid'])],
  ['stdbuf', wrapper('ioe', ['--input', '--output', '--error'])],
  ['chroot', wrapper('', ['--userspec', '--groups'], 1)],
  ['xargs', wrapper('IndsEaPL', ['--max-args', '--max-procs', '--max-chars', '--delimiter', '--arg-file', '--eof', '--max-lines', '--process-slot-var'])],
])

function closerOf(quote: string): string {
  return quote === ANSI_QUOTE ? '\'' : quote
}

// A `#` starts a comment at the start of a word, never inside one such as `$#` or `a#b`.
function startsComment(command: string, i: number): boolean {
  const before = command[i - 1] ?? ''

  return i === 0 || WHITESPACE.test(before) || COMMENT_PREFIXES.has(before)
}

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

// Where the heredocs opened on a line end: from the newline closing that line to the end of the last delimiter line, a CRLF one included.
function heredocEnd(command: string, newline: number, words: readonly { word: string, stripsTabs: boolean }[]): number {
  let lineStart = newline + 1

  for (const { word, stripsTabs } of words) {
    while (lineStart <= command.length) {
      const next = command.indexOf('\n', lineStart)
      const lineEnd = next === -1 ? command.length : next
      const line = command.slice(lineStart, lineEnd).replace(TRAILING_CR, '')

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

// Splits on the shell separators outside quotes, comments and heredocs, so the `;` and `|` of an inline script stay in its piece, each piece keeping where it sits in the command.
export function splitCommand(command: string): Piece[] {
  const bounds: [number, number, string][] = []
  const bodies: [number, number, boolean][] = []
  const comments: [number, number][] = []
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
      if (char === closerOf(quote))
        quote = null

      continue
    }

    if (char === '$' && command[i + 1] === '\'') {
      quote = ANSI_QUOTE
      i++

      continue
    }

    if (char === '\'' || char === '"') {
      quote = char

      continue
    }

    // A backquoted body is read whole, as its own separators split nothing of the command around it.
    if (char === '`') {
      i = closingBackquote(command, i)

      continue
    }

    if (char === '#' && startsComment(command, i)) {
      const newline = command.indexOf('\n', i)
      const end = newline === -1 ? command.length : newline

      comments.push([i, end])
      i = end - 1

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

  const ranges = [...bodies, ...comments].map(([from, to]): [number, number] => [from, to]).sort(([a], [b]) => a - b)

  return bounds.map(([from, to, separator]) => {
    const inside = bodies.filter(([body]) => body >= from && body < to)

    return {
      text: command.slice(from, to),
      start: from,
      end: to,
      command: withoutRanges(command, from, to, ranges),
      separator,
      expanded: inside.filter(([, , expands]) => expands).map(([body, bodyEnd]) => command.slice(body, bodyEnd)).join(''),
      heredocs: inside.map(([body, bodyEnd]) => command.slice(body, bodyEnd)),
    }
  })
}

// True when the text holds no redirect, substitution, subshell or group outside single quotes, and closes every quote it opens.
export function isPlain(text: string): boolean {
  let quote: string | null = null

  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    const isSubstitution = char === '`' || (char === '$' && text[i + 1] === '(')

    if (quote === null && char === '$' && text[i + 1] === '\'') {
      quote = ANSI_QUOTE
      i++

      continue
    }

    if (char === '\\' && quote !== '\'')
      i++
    else if (quote !== null && char === closerOf(quote))
      quote = null
    else if (quote === null && (char === '"' || char === '\''))
      quote = char
    else if (quote !== '\'' && quote !== ANSI_QUOTE && (isSubstitution || (quote === null && PLAIN_BREAKERS.has(char))))
      return false
  }

  return quote === null
}

// How many `)` the text closes without opening, as the end of a subshell does.
function unmatchedClosers(text: string): number {
  let depth = 0
  let unmatched = 0
  let quote: string | null = null

  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''

    if (quote === null && char === '$' && text[i + 1] === '\'') {
      quote = ANSI_QUOTE
      i++

      continue
    }

    if (char === '\\' && quote !== '\'')
      i++
    else if (quote !== null && char === closerOf(quote))
      quote = null
    else if (quote === null && (char === '"' || char === '\''))
      quote = char
    else if (quote === null && char === '(')
      depth++
    else if (quote === null && char === ')' && depth > 0)
      depth--
    else if (quote === null && char === ')')
      unmatched++
  }

  return unmatched
}

// A piece less the `(` opening its subshell and the `)` closing it, so the last word of `(cat .env)` is the file.
function withoutSubshell(text: string): string {
  let result = text.trim()
  let closers = unmatchedClosers(result)

  while (result.startsWith('(')) result = result.slice(1).trimStart()

  while (closers > 0 && result.endsWith(')')) {
    result = result.slice(0, -1).trimEnd()
    closers--
  }

  return result
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
      if (char === closerOf(quote))
        quote = null
    }
    else if (char === '$' && text[i + 1] === '\'') {
      quote = ANSI_QUOTE
      i++
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

// The bodies of the outermost `$(...)`, `<(...)`, `>(...)` and backquotes; quotes only count where `isQuoting`, as a heredoc body holds them as plain text.
function bodies(text: string, isQuoting: boolean): string[] {
  const found: string[] = []
  let quote: string | null = null

  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    const next = text[i + 1]

    if (quote === '\'') {
      if (char === '\'')
        quote = null
    }
    else if (quote === ANSI_QUOTE) {
      if (char === '\\')
        i++
      else if (char === '\'')
        quote = null
    }
    else if (char === '\\') {
      i++
    }
    else if ((char === '$' && next === '(') || (isQuoting && quote === null && (char === '<' || char === '>') && next === '(')) {
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
    else if (isQuoting && char === '$' && next === '\'' && quote === null) {
      quote = ANSI_QUOTE
      i++
    }
    else if (isQuoting && char === '\'' && quote === null) {
      quote = char
    }
  }

  return found
}

// The commands each piece runs through `$(...)`, `<(...)` or backquotes, inside double quotes and unquoted heredoc bodies too; a nested one is found by reading each result in turn.
export function substitutions(command: string): string[] {
  return splitCommand(command).flatMap(piece => [...bodies(piece.command, true), ...bodies(piece.expanded, false)])
}

// A word as the shell would pass it; `isProse` when a quoted part of it holds whitespace, a message or a pattern rather than a path, `hasGlob` and `hasBrace` when it holds an unquoted `*?[` or `{` the shell would expand.
export interface Word { text: string, isProse: boolean, hasGlob: boolean, hasBrace: boolean }

// What the backslash escape at `at` inside `$'...'` stands for, and the index of its last character.
function ansiEscape(text: string, at: number): [string, number] {
  const letter = text[at + 1] ?? ''
  const simple = ANSI_ESCAPES[letter]

  if (simple !== undefined)
    return [simple, at + 1]

  const hex = LEADING_HEX.exec(text.slice(at + 2, at + 2 + (ANSI_DIGITS[letter] ?? 0)))?.[0] ?? ''

  if (hex !== '')
    return [String.fromCodePoint(Number.parseInt(hex, 16)), at + 1 + hex.length]

  const octal = OCTAL.exec(text.slice(at + 1))?.[0]

  if (octal !== undefined)
    return [String.fromCodePoint(Number.parseInt(octal, 8)), at + octal.length]

  return [`\\${letter}`, at + 1]
}

// The words of a piece, quotes and line continuations removed.
export function words(text: string): Word[] {
  const found: Word[] = []
  let current = ''
  let isStarted = false
  let isProse = false
  let hasGlob = false
  let hasBrace = false
  let quote: string | null = null

  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? ''
    const isContinuation = char === '\\' && quote !== '\'' && text[i + 1] === '\n'

    if (isContinuation)
      i++

    if (quote === null && (isContinuation || WHITESPACE.test(char))) {
      if (isStarted)
        found.push({ text: current, isProse, hasGlob, hasBrace })

      current = ''
      isStarted = false
      isProse = false
      hasGlob = false
      hasBrace = false

      continue
    }

    if (isContinuation)
      continue

    isStarted = true

    // within double quotes a backslash escapes only `$`, a backtick, `"` and itself, and stays before anything else (`"v\d"`)
    if (char === '\\' && quote === ANSI_QUOTE) {
      const [decoded, last] = ansiEscape(text, i)

      current += decoded
      i = last
    }
    else if (char === '\\' && quote === '"' && !DOUBLE_QUOTED_ESCAPES.has(text[i + 1] ?? '')) {
      current += char
    }
    else if (char === '\\' && quote !== '\'') {
      current += text[++i] ?? ''
    }
    else if (quote !== null && char === closerOf(quote)) {
      quote = null
    }
    else if (quote === null && char === '$' && text[i + 1] === '\'') {
      quote = ANSI_QUOTE
      i++
    }
    else if (quote === null && (char === '"' || char === '\'')) {
      quote = char
    }
    else {
      current += char
      hasGlob ||= quote === null && GLOB_CHARS.has(char)
      hasBrace ||= quote === null && char === '{'
    }

    isProse ||= quote !== null && WHITESPACE.test(char)
  }

  if (isStarted)
    found.push({ text: current, isProse, hasGlob, hasBrace })

  return found
}

// The words of a piece as the shell would pass them, quotes and line continuations removed.
export function tokenize(text: string): string[] {
  return words(text).map(word => word.text)
}

// Drops the options of a wrapper and the values they take, then its leading operands; `env -S` splits its value into the command it runs.
function skipOptions(tokens: string[], spec: WrapperSpec): void {
  const take = (name: string, attached: string) => {
    const value = attached === '' ? (tokens.shift() ?? '') : attached

    if (name === 'S' || name === '--split-string')
      tokens.unshift(...tokenize(value))
  }

  while (tokens[0] !== undefined && tokens[0].startsWith('-') && tokens[0] !== '-') {
    const option = tokens.shift() ?? ''

    if (option === '--')
      break

    if (option.startsWith('--')) {
      const [name = '', ...value] = option.split('=')

      if (spec.long.includes(name))
        take(name, value.join('='))

      continue
    }

    for (const [index, letter] of [...option.slice(1)].entries()) {
      if (!spec.short.includes(letter))
        continue

      // the value is what follows the letter, else the next word
      take(letter, option.slice(index + 2))

      break
    }
  }

  for (let operand = 0; operand < spec.operands; operand++) tokens.shift()
}

// The program a piece runs, by its base name, past any subshell opener, keyword, variable assignment or wrapper such as `env` or `sudo`.
export function parseCommand(text: string): Invocation {
  const tokens = tokenize(text)
  const assignments: string[] = []
  let isWrapped = false

  for (;;) {
    const first = tokens[0] ?? ''
    const spec = WRAPPERS.get(first.split('/').pop() ?? '')

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
    else if (KEYWORDS.has(first)) {
      isWrapped = true
      tokens.shift()
    }
    else if (first === 'case') {
      isWrapped = true
      const at = tokens.indexOf('in')

      tokens.splice(0, at === -1 ? tokens.length : at + 1)
    }
    else if (tokens.length > 1 && CASE_LABEL.test(first)) {
      isWrapped = true
      tokens.shift()
    }
    else if (spec !== undefined) {
      isWrapped = true
      tokens.shift()
      skipOptions(tokens, spec)
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

// A word as a POSIX shell or zsh reads it back unchanged: left bare when it holds nothing the shell would act on (zsh expands a leading `=`), else single-quoted.
export function shellQuote(word: string): string {
  return SAFE_WORD.test(word) && !word.startsWith('=') ? word : `'${word.replaceAll('\'', '\'\\\'\'')}'`
}

function quoted(word: string): string {
  return word === '{}' ? word : shellQuote(word)
}

// The command strings a piece hands to a shell with `-c`, wherever the shell sits in it (`docker exec db sh -c '...'`, `su -c '...'`).
function commandStrings(tokens: readonly string[]): string[] {
  const found: string[] = []

  for (const [i, token] of tokens.entries()) {
    const name = token.split('/').pop() ?? ''

    if (!COMMAND_STRING_PROGRAMS.has(name))
      continue

    const isUser = name === 'su' || name === 'runuser'
    let isValue = false

    for (let j = i + 1; j < tokens.length; j++) {
      const option = tokens[j] ?? ''

      if (isValue) {
        isValue = false

        continue
      }

      if (SHELL_VALUE_OPTIONS.has(option)) {
        isValue = true

        continue
      }

      if (option.startsWith('--command=')) {
        found.push(option.slice('--command='.length))

        break
      }

      if (option === '--command' || (!option.startsWith('--') && option.startsWith('-') && option.slice(1).includes('c'))) {
        found.push(tokens[j + 1] ?? '')

        break
      }

      if (!option.startsWith('-') && !isUser)
        break
    }
  }

  return found
}

// A piece's arguments less its redirections, and the words fed to it as here-strings.
function redirections(args: readonly string[]): { operands: string[], hereStrings: string[] } {
  const operands: string[] = []
  const hereStrings: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (arg.startsWith('<<<'))
      hereStrings.push(arg.length > 3 ? arg.slice(3) : (args[++i] ?? ''))
    else if (REDIRECT_ONLY.test(arg))
      i++
    else if (!REDIRECT_START.test(arg))
      operands.push(arg)
  }

  return { operands, hereStrings }
}

// The argv `find` hands to each `-exec`, up to its `;` or `+`.
function findExecs(args: readonly string[]): string[] {
  const found: string[] = []

  for (const [i, arg] of args.entries()) {
    if (!FIND_EXEC.has(arg))
      continue

    const rest = args.slice(i + 1)
    const end = rest.findIndex(word => word === ';' || word === '+')

    found.push((end === -1 ? rest : rest.slice(0, end)).map(quoted).join(' '))
  }

  return found
}

// The commands a piece makes a shell run besides its own: `sh -c` strings, `eval`, `find -exec`, and what is fed to a shell reading its input, heredocs, here-strings and an `echo` piped in.
function nestedCommands(piece: Piece, previous: Piece | undefined): string[] {
  const tokens = tokenize(piece.command)
  const { program, args } = parseCommand(piece.command)
  const found = commandStrings(tokens)

  if (program === 'eval')
    found.push(args.join(' '))

  if (program === 'find')
    found.push(...findExecs(args))

  if (!SHELLS.has(program))
    return found

  const { operands, hereStrings } = redirections(args)

  if (operands.length > 0)
    return found

  found.push(...piece.heredocs, ...hereStrings)

  if (previous?.separator === '|') {
    const before = parseCommand(previous.command)

    if (PRINTERS.has(before.program))
      found.push(...before.args, before.args.join(' '))
  }

  return found
}

// The command and every command it makes the shell run: substitutions, subshells, `sh -c` and `eval` strings, `find -exec`, and what is fed to a shell; each is one to check.
export function commandsRun(command: string, depth = 0): string[] {
  const found = [command]

  if (depth >= MAX_DEPTH)
    return found

  const pieces = splitCommand(command)

  for (const [index, piece] of pieces.entries()) {
    const inner = withoutSubshell(piece.command)
    const nested = [...bodies(piece.command, true), ...bodies(piece.expanded, false), ...nestedCommands(piece, pieces[index - 1])]

    if (inner !== piece.command.trim())
      nested.push(inner)

    for (const each of nested)
      found.push(...commandsRun(each, depth + 1))
  }

  return found
}

function expandBraces(word: string): string[] {
  const open = word.indexOf('{')

  if (open === -1)
    return [word]

  const alternatives: string[] = []
  let depth = 0
  let cut = open

  for (let i = open; i < word.length; i++) {
    const char = word[i]

    if (char === '{') {
      depth++
    }
    else if (char === ',' && depth === 1) {
      alternatives.push(word.slice(cut + 1, i))
      cut = i
    }
    else if (char === '}' && --depth === 0) {
      if (alternatives.length === 0)
        break

      alternatives.push(word.slice(cut + 1, i))

      const prefix = word.slice(0, open)
      const suffix = word.slice(i + 1)

      return alternatives.flatMap(alternative => expandBraces(prefix + alternative + suffix)).slice(0, MAX_BRACES + 1)
    }
  }

  // no list at this brace: keep it and expand what follows
  return expandBraces(word.slice(open + 1)).map(rest => `${word.slice(0, open + 1)}${rest}`)
}

// The words a word with `{a,b}` lists stands for, `.{e,}nv` being `.env` and `.nv`; a word with no list, or one growing past a sane size, is returned as it is.
export function braceExpand(word: string): string[] {
  const found = expandBraces(word)

  return found.length > MAX_BRACES ? [word] : found
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
