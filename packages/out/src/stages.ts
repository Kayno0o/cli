import { tokenize } from '@kaynooo/cli-kit/shell'

const DIGITS = /^\d+$/
const SIGNED = /^[+-]?\d+$/
const SHORT_COUNT = /^-(\d+)$/
const GREP_FLAGS = new Set(['i', 'v', 'E', 'F', 'w', 'x', 'n', 'H', 'h', 's', 'a', 'I', 'P', 'G'])
const GREP_VALUES = new Set(['e', 'm', 'A', 'B', 'C'])
const LONG_VALUE = /^--(lines|regexp|max-count|after-context|before-context|context)=(.*)$/
const LONG_NAMES: Record<string, string> = { 'lines': 'n', 'regexp': 'e', 'max-count': 'm', 'after-context': 'A', 'before-context': 'B', 'context': 'C' }
const LONG_FLAGS: Record<string, string> = { '--ignore-case': 'i', '--invert-match': 'v', '--extended-regexp': 'E', '--fixed-strings': 'F', '--word-regexp': 'w', '--line-regexp': 'x', '--line-number': 'n' }
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g
// In a basic regex these are literal unless escaped, the other way round from JavaScript's.
const BASIC_SWAPPED = new Set(['(', ')', '|', '+', '?', '{', '}'])
const DEFAULT_LINES = 10

interface Options { flags: Set<string>, values: Map<string, string[]>, operands: string[] }

// The options and operands of a stage, undefined on an option it does not know, so the stage is not guessed at.
function options(args: readonly string[], flags: ReadonlySet<string>, valued: ReadonlySet<string>): Options | undefined {
  const read: Options = { flags: new Set(), values: new Map(), operands: [] }
  const add = (name: string, value: string) => read.values.set(name, [...read.values.get(name) ?? [], value])

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    const long = LONG_VALUE.exec(arg)
    const count = SHORT_COUNT.exec(arg)

    if (long !== null) {
      add(LONG_NAMES[long[1] ?? ''] ?? '', long[2] ?? '')
    }
    else if (LONG_FLAGS[arg] !== undefined) {
      read.flags.add(LONG_FLAGS[arg])
    }
    else if (count !== null) {
      add('count', count[1] ?? '')
    }
    else if (arg.startsWith('-') && arg.length > 1 && !arg.startsWith('--')) {
      for (const [at, letter] of [...arg.slice(1)].entries()) {
        if (valued.has(letter)) {
          const glued = arg.slice(at + 2)

          add(letter, glued === '' ? args[++i] ?? '' : glued)

          break
        }

        if (!flags.has(letter))
          return undefined

        read.flags.add(letter)
      }
    }
    else if (arg.startsWith('--')) {
      return undefined
    }
    else {
      read.operands.push(arg)
    }
  }

  return read
}

// `tail` or `head` on the lines: `-n 20`, `-20`, `-n +5` from the fifth line for tail, `-n -5` all but the last five for head.
function cut(lines: readonly string[], bin: string, args: readonly string[]): string[] | undefined {
  const read = options(args, new Set(['q', 'v']), new Set(['n']))
  const value = read?.values.get('n')?.at(-1) ?? read?.values.get('count')?.at(-1) ?? String(DEFAULT_LINES)

  if (read === undefined || read.operands.length > 0 || !SIGNED.test(value))
    return undefined

  const n = Math.abs(Number(value))

  if (bin === 'tail')
    return value.startsWith('+') ? lines.slice(Math.max(0, n - 1)) : lines.slice(Math.max(0, lines.length - n))

  return value.startsWith('-') ? lines.slice(0, Math.max(0, lines.length - n)) : lines.slice(0, n)
}

// A basic or extended grep pattern as a JavaScript one, close enough for counting what it would print.
function patternSource(pattern: string, read: Options): string {
  if (read.flags.has('F'))
    return pattern.replaceAll(REGEX_SPECIAL, '\\$&')

  if (read.flags.has('E') || read.flags.has('P'))
    return pattern

  let source = ''

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? ''
    const next = pattern[i + 1] ?? ''

    if (char === '\\' && BASIC_SWAPPED.has(next)) {
      source += next
      i++
    }
    else if (char === '\\') {
      source += `${char}${next}`
      i++
    }
    else {
      source += BASIC_SWAPPED.has(char) ? `\\${char}` : char
    }
  }

  return source
}

// The pattern held to whole lines with -x or whole words with -w.
function anchoredSource(source: string, flags: ReadonlySet<string>): string {
  if (flags.has('x'))
    return `^(?:${source})$`

  return flags.has('w') ? `\\b(?:${source})\\b` : source
}

// The lines `grep` would print, with its context lines and the `--` between groups that do not touch.
function search(lines: readonly string[], args: readonly string[]): string[] | undefined {
  const read = options(args, GREP_FLAGS, GREP_VALUES)

  if (read === undefined)
    return undefined

  const patterns = read.values.get('e') ?? read.operands.splice(0, 1)
  const numbers = ['A', 'B', 'C', 'm', 'count'].map(name => read.values.get(name)?.at(-1))

  if (patterns.length === 0 || read.operands.length > 0 || numbers.some(each => each !== undefined && !DIGITS.test(each)))
    return undefined

  const [after, before, context, max, count] = numbers.map(each => each === undefined ? undefined : Number(each))
  let regex

  try {
    const source = patterns.map(pattern => `(?:${patternSource(pattern, read)})`).join('|')

    regex = new RegExp(anchoredSource(source, read.flags), read.flags.has('i') ? 'i' : '')
  }
  catch {
    return undefined
  }

  const matched: number[] = []

  for (const [index, line] of lines.entries()) {
    if (regex.test(line) !== read.flags.has('v'))
      matched.push(index)

    if (max !== undefined && matched.length >= max)
      break
  }

  const ahead = before ?? context ?? count ?? 0
  const behind = after ?? context ?? count ?? 0
  const kept: string[] = []
  let last = -1

  for (const index of matched) {
    const from = Math.max(last + 1, index - ahead)

    if (last >= 0 && from > last + 1 && ahead + behind > 0)
      kept.push('--')

    for (let at = from; at <= Math.min(lines.length - 1, index + behind); at++)
      kept.push(lines[at] ?? '')

    last = Math.max(last, Math.min(lines.length - 1, index + behind))
  }

  return kept
}

// What the `tail`, `head` and `grep` stages a command was piped through would have printed of its output, in order; undefined when one cannot be read, so the output is taken whole.
export function filtered(text: string, stages: readonly string[]): string | undefined {
  const ended = text.endsWith('\n')
  let lines: string[] | undefined = (ended ? text.slice(0, -1) : text).split('\n')

  for (const stage of stages) {
    const [bin = '', ...args] = tokenize(stage)

    if (bin === 'grep')
      lines = search(lines, args)
    else
      lines = bin === 'tail' || bin === 'head' ? cut(lines, bin, args) : undefined

    if (lines === undefined)
      return undefined
  }

  return lines.length === 0 ? '' : `${lines.join('\n')}${ended ? '\n' : ''}`
}
