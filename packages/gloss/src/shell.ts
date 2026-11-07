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
const CONTROL = /\|&|\|\||\||&&|[&;\n]/y
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

// Reads the word starting at `from`, up to the next blank or operator outside quotes.
function readWord(line: string, from: number): Read {
  const substitutions: string[] = []
  let text = ''
  let i = from

  while (i < line.length) {
    const ch = line[i]!

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '|' || ch === '&' || ch === ';' || ch === '<' || ch === '>')
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

  return { word: { text, start: from, end: i }, substitutions }
}

function emptyCommand(): Command {
  return { assigns: [], words: [], redirects: [], substitutions: [] }
}

// Splits a command line into its simple commands and what joins them. It never throws: an unclosed quote runs to the end of the line.
export function parseLine(line: string): Step[] {
  const steps: Step[] = []
  let command = emptyCommand()
  let i = 0

  const finish = (next: Operator | undefined): void => {
    if (command.words.length > 0 || command.assigns.length > 0 || command.redirects.length > 0)
      steps.push({ command, next })
    else if (next !== undefined && steps.length > 0)
      steps.at(-1)!.next = next

    command = emptyCommand()
  }

  while (i < line.length) {
    const ch = line[i]!

    if (ch === ' ' || ch === '\t') {
      i++

      continue
    }

    if (ch === '#')
      break

    const control = matchAt(CONTROL, line, i)

    if (control !== undefined) {
      finish(control === '\n' ? ';' : control as Operator)
      i += control.length

      continue
    }

    const fd = matchAt(FD, line, i)
    const redirectAt = i + (fd?.length ?? 0)
    const redirect = matchAt(REDIRECT, line, redirectAt)

    if (redirect !== undefined) {
      i = redirectAt + redirect.length

      while (line[i] === ' ' || line[i] === '\t')
        i++

      const read = i < line.length && matchAt(CONTROL, line, i) === undefined ? readWord(line, i) : undefined

      command.redirects.push({ op: redirect, fd, target: read?.word, start: i - redirect.length - (fd?.length ?? 0), end: read?.word.end ?? i })
      command.substitutions.push(...read?.substitutions ?? [])
      i = read?.word.end ?? i

      continue
    }

    const { word, substitutions } = readWord(line, i)

    command.substitutions.push(...substitutions)

    if (command.words.length === 0 && ASSIGN.test(word.text))
      command.assigns.push(word)
    else
      command.words.push(word)

    i = Math.max(word.end, i + 1)
  }

  finish(undefined)

  return steps
}
