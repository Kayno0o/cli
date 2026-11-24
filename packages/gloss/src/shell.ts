import { parseCommand, splitCommand } from '@kaynooo/cli-kit/shell'

export type Operator = '|' | '|&' | '&&' | '||' | ';' | '&'

export interface Word {
  // The word as the shell hands it over: quotes and escapes removed, substitutions left as written.
  text: string
  start: number
  end: number
}

export interface Redirect {
  op: string
  fd: string | undefined
  target: Word | undefined
  start: number
  end: number
}

export interface Command {
  assigns: Word[]
  words: Word[]
  redirects: Redirect[]
  // The inside of each $(...) and backtick substitution, to explain on its own.
  substitutions: string[]
}

export interface Step {
  command: Command
  // What joins this command to the next one.
  next: Operator | undefined
}

const REDIRECT = /&>>?|>&|<&|<<<|<<-?|>>|>\||>|</y
const ASSIGN = /^[A-Z_]\w*\+?=/i
const FD = /\d+(?=[<>])/y
const ESCAPABLE_IN_QUOTES = new Set(['"', '\\', '$', '`'])

function matchAt(pattern: RegExp, line: string, index: number): string | undefined {
  pattern.lastIndex = index

  return pattern.exec(line)?.[0]
}

// The index just after the parenthesis closing the $( at `open`, quotes inside it skipped.
function closeParen(line: string, open: number): number {
  let depth = 0

  for (let i = open; i < line.length; i++) {
    const ch = line[i]

    if (ch === '\\')
      i++
    else if (ch === '\'' || ch === '"' || ch === '`')
      i = closeQuote(line, i) - 1
    else if (ch === '(')
      depth++
    else if (ch === ')' && --depth === 0)
      return i + 1
  }

  return line.length
}

function closeQuote(line: string, open: number): number {
  const quote = line[open]!

  for (let i = open + 1; i < line.length; i++) {
    if (line[i] === '\\' && quote !== '\'')
      i++
    else if (line[i] === quote)
      return i + 1
  }

  return line.length
}

function closeBrace(line: string, open: number): number {
  const close = line.indexOf('}', open)

  return close === -1 ? line.length : close + 1
}

interface Read {
  word: Word
  substitutions: string[]
}

// Reads the word starting at `from`, up to the next blank or redirect outside quotes.
function readWord(line: string, from: number, offset: number): Read {
  const substitutions: string[] = []
  let text = ''
  let i = from

  while (i < line.length) {
    const ch = line[i]!

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<' || ch === '>' || (ch === '&' && line[i + 1] === '>'))
      break

    if (ch === '\\') {
      text += line[i + 1] ?? ''
      i += 2
    }
    else if (ch === '\'') {
      const end = closeQuote(line, i)

      text += line.slice(i + 1, line[end - 1] === '\'' && end - 1 > i ? end - 1 : end)
      i = end
    }
    else if (ch === '"') {
      const end = closeQuote(line, i)
      const inner = line.slice(i + 1, line[end - 1] === '"' && end - 1 > i ? end - 1 : end)

      for (let j = 0; j < inner.length; j++) {
        if (inner[j] === '\\' && ESCAPABLE_IN_QUOTES.has(inner[j + 1] ?? '')) {
          text += inner[j + 1]!
          j++
        }
        else if (inner[j] === '$' && inner[j + 1] === '(') {
          const close = closeParen(inner, j + 1)

          substitutions.push(inner.slice(j + 2, inner[close - 1] === ')' ? close - 1 : close))
          text += inner.slice(j, close)
          j = close - 1
        }
        else {
          text += inner[j]
        }
      }

      i = end
    }
    else if (ch === '$' && line[i + 1] === '(') {
      const close = closeParen(line, i + 1)

      substitutions.push(line.slice(i + 2, line[close - 1] === ')' ? close - 1 : close))
      text += line.slice(i, close)
      i = close
    }
    else if (ch === '$' && line[i + 1] === '{') {
      const close = closeBrace(line, i + 1)

      text += line.slice(i, close)
      i = close
    }
    else if (ch === '`') {
      const end = closeQuote(line, i)

      substitutions.push(line.slice(i + 1, line[end - 1] === '`' && end - 1 > i ? end - 1 : end))
      text += line.slice(i, end)
      i = end
    }
    else {
      text += ch
      i++
    }
  }

  return { word: { text, start: offset + from, end: offset + i }, substitutions }
}

function normalizeSeparator(separator: string): Operator | undefined {
  if (separator === '')
    return undefined

  return separator === '\n' ? ';' : separator as Operator
}

// Splits a command line into its simple commands using `@kaynooo/cli-kit/shell` for separator/comment/heredoc handling, while keeping character offsets and redirects.
export function parseLine(line: string): Step[] {
  const steps: Step[] = []

  for (const piece of splitCommand(line)) {
    const command: Command = { assigns: [], words: [], redirects: [], substitutions: [] }
    const text = piece.command
    let i = 0

    while (i < text.length) {
      const ch = text[i]!

      if (ch === ' ' || ch === '\t' || ch === '\n') {
        i++

        continue
      }

      const fd = matchAt(FD, text, i)
      const redirectAt = i + (fd?.length ?? 0)
      const redirect = matchAt(REDIRECT, text, redirectAt)

      if (redirect !== undefined) {
        const start = piece.start + i

        i = redirectAt + redirect.length

        while (text[i] === ' ' || text[i] === '\t')
          i++

        const read = i < text.length ? readWord(text, i, piece.start) : undefined

        command.redirects.push({ op: redirect, fd, target: read?.word, start, end: read?.word.end ?? piece.start + i })
        command.substitutions.push(...read?.substitutions ?? [])
        i = read === undefined ? i : read.word.end - piece.start

        continue
      }

      const { word, substitutions } = readWord(text, i, piece.start)

      command.substitutions.push(...substitutions)

      if (command.words.length === 0 && ASSIGN.test(word.text))
        command.assigns.push(word)
      else
        command.words.push(word)

      i = Math.max(word.end - piece.start, i + 1)
    }

    const next = normalizeSeparator(piece.separator)

    if (command.words.length > 0 || command.assigns.length > 0 || command.redirects.length > 0)
      steps.push({ command, next })
    else if (next !== undefined && steps.length > 0)
      steps.at(-1)!.next = next
  }

  return steps
}

export interface Unwrapped {
  wrappers: string[]
  assigns: string[]
  words: Word[]
}

// Unwraps leading wrappers (`sudo`, `env`, `out --`, `slot --`, `timeout`, `nice`, etc.) via `@kaynooo/cli-kit/shell`'s `parseCommand`.
export function unwrapCommand(words: Word[]): Unwrapped {
  if (words.length < 2)
    return { wrappers: [], assigns: [], words }

  const raw = words.map(word => word.text).join(' ')
  const parsed = parseCommand(raw)

  if (!parsed.isWrapped || parsed.program === '')
    return { wrappers: [], assigns: [], words }

  const targetCount = 1 + parsed.args.length

  if (targetCount >= words.length)
    return { wrappers: [], assigns: [], words }

  const splitAt = words.length - targetCount
  const prefix = words.slice(0, splitAt)
  const rest = words.slice(splitAt)
  const assigns: string[] = []
  const wrapperWords: string[] = []

  for (const word of prefix) {
    if (ASSIGN.test(word.text))
      assigns.push(word.text)
    else
      wrapperWords.push(word.text)
  }

  return {
    wrappers: wrapperWords.length > 0 ? [wrapperWords.join(' ')] : [],
    assigns,
    words: rest,
  }
}
