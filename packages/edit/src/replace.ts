import { counted, plural } from '@kaynooo/utils/text'

export interface Pair {
  from: string
  to: string
  // Matches expected; ignored with all, which takes any number from one.
  count?: number
  all?: boolean
  regex?: boolean
  // Regex flags: case-insensitive, and the dot matching a newline.
  ignoreCase?: boolean
  dotAll?: boolean
}

export interface Applied {
  text: string
  // The line of each match, counted in the text its pair ran on.
  lines: number[]
  problems: string[]
  // Matches over all the pairs, 0 for a file none of them touches.
  matched: number
}

const CRLF = /\r?\n/g
// A ${1} or ${name} reference in a regex --to, an escaped $$ matched first so it stays literal.
const BRACED_GROUP = /\$\$|\$\{(\w+)\}/g
const DIGITS = /^\d+$/
// A \n or \t typed in a regex --to, an escaped backslash matched first so \\n stays literal.
const ESCAPE = /\\\\|\\([nt])/g
const LONGEST_LIST = 8

function linesOf(text: string, indexes: number[]): number[] {
  const lines: number[] = []
  let line = 1
  let at = 0

  for (const index of indexes) {
    for (; at < index; at++) {
      if (text[at] === '\n')
        line++
    }

    lines.push(line)
  }

  return lines
}

export function listLines(lines: number[]): string {
  const shown = lines.slice(0, LONGEST_LIST).join(', ')

  return lines.length > LONGEST_LIST ? `${shown} and ${lines.length - LONGEST_LIST} more` : shown
}

function literalIndexes(text: string, from: string): number[] {
  const found: number[] = []

  for (let at = text.indexOf(from); at !== -1; at = text.indexOf(from, at + from.length))
    found.push(at)

  return found
}

// Where the first line of a text that matched nowhere does appear, the usual sign of an indentation or neighbouring-line mismatch.
function firstLineHint(text: string, from: string): string {
  const first = from.split('\n').find(line => line.trim() !== '')?.trim()

  if (first === undefined || first === from.trim())
    return ''

  const lines = text.split('\n').flatMap((line, i) => line.includes(first) ? [i + 1] : [])

  return lines.length === 0 ? '' : ` (its first line is on ${plural('line', lines.length)} ${listLines(lines)})`
}

export function compile(source: string, { ignoreCase, dotAll }: Pick<Pair, 'ignoreCase' | 'dotAll'> = {}): RegExp {
  return new RegExp(source, `gm${ignoreCase === true ? 'i' : ''}${dotAll === true ? 's' : ''}`)
}

function escapes(to: string): string {
  return to.replace(ESCAPE, (whole, letter: string | undefined) => letter === undefined ? whole : letter === 'n' ? '\n' : '\t')
}

// String.replace leaves ${1} and ${name} as they are, so they become $01 and $<name>: the two-digit form keeps digits typed after the group out of its number; ${0} is the whole match.
function bracedGroups(to: string): string {
  return to.replace(BRACED_GROUP, (whole, group: string | undefined) => {
    if (group === undefined)
      return whole

    if (!DIGITS.test(group))
      return `$<${group}>`

    return Number(group) === 0 ? '$&' : `$${group.padStart(2, '0')}`
  })
}

// Applies the pairs in order, each to the previous one's result, and lists every pair that matched another number of times than expected.
export function applyPairs(original: string, pairs: Pair[]): Applied {
  const crlf = original.includes('\r\n')
  const lines: number[] = []
  const problems: string[] = []
  let matched = 0
  let text = original

  for (const [i, pair] of pairs.entries()) {
    const label = pairs.length > 1 ? `pair ${i + 1}: ` : ''
    // A file with CRLF endings still matches a --from typed with plain newlines.
    const from = crlf && pair.regex !== true ? pair.from.replace(CRLF, '\r\n') : pair.from
    const typed = pair.regex === true ? escapes(pair.to) : pair.to
    const to = crlf ? typed.replace(CRLF, '\r\n') : typed
    const pattern = pair.regex === true ? compile(from, pair) : undefined
    const indexes = pattern === undefined ? literalIndexes(text, from) : [...text.matchAll(pattern)].map(match => match.index)
    const found = linesOf(text, indexes)

    matched += indexes.length

    const expected = pair.count ?? 1

    if (pair.all === true ? indexes.length === 0 : indexes.length !== expected) {
      const wanted = pair.all === true ? 'at least 1' : String(expected)
      let where = ` on lines ${listLines(found)}: add context to --from, or pass --count ${indexes.length} or --all`

      if (indexes.length === 0)
        where = pattern === undefined ? firstLineHint(text, from) : ''

      problems.push(`${label}matched ${counted(indexes.length, 'time')}, expected ${wanted}${where}`)

      continue
    }

    lines.push(...found)
    text = pattern === undefined ? text.split(from).join(to) : text.replace(pattern, bracedGroups(to))
  }

  return { text, lines, problems, matched }
}
