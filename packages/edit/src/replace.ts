export interface Pair {
  from: string
  to: string
  // Matches expected; ignored with all, which takes any number from one.
  count?: number
  all?: boolean
  regex?: boolean
}

export interface Applied {
  text: string
  // The line of each match, counted in the text its pair ran on.
  lines: number[]
  problems: string[]
}

const CRLF = /\r?\n/g
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

  return lines.length === 0 ? '' : ` (its first line is on line${lines.length > 1 ? 's' : ''} ${listLines(lines)})`
}

export function compile(source: string): RegExp {
  return new RegExp(source, 'gm')
}

// Applies the pairs in order, each to the previous one's result, and lists every pair that matched another number of times than expected.
export function applyPairs(original: string, pairs: Pair[]): Applied {
  const crlf = original.includes('\r\n')
  const lines: number[] = []
  const problems: string[] = []
  let text = original

  for (const [i, pair] of pairs.entries()) {
    const label = pairs.length > 1 ? `pair ${i + 1}: ` : ''
    // A file with CRLF endings still matches a --from typed with plain newlines.
    const from = crlf && pair.regex !== true ? pair.from.replace(CRLF, '\r\n') : pair.from
    const to = crlf && pair.regex !== true ? pair.to.replace(CRLF, '\r\n') : pair.to
    const pattern = pair.regex === true ? compile(from) : undefined
    const indexes = pattern === undefined ? literalIndexes(text, from) : [...text.matchAll(pattern)].map(match => match.index)
    const found = linesOf(text, indexes)
    const expected = pair.count ?? 1

    if (pair.all === true ? indexes.length === 0 : indexes.length !== expected) {
      const wanted = pair.all === true ? 'at least 1' : String(expected)
      let where = ` on lines ${listLines(found)}: add context to --from, or pass --count ${indexes.length} or --all`

      if (indexes.length === 0)
        where = pattern === undefined ? firstLineHint(text, from) : ''

      problems.push(`${label}matched ${indexes.length} time${indexes.length === 1 ? '' : 's'}, expected ${wanted}${where}`)

      continue
    }

    lines.push(...found)
    text = pattern === undefined ? text.split(from).join(to) : text.replace(pattern, to)
  }

  return { text, lines, problems }
}
