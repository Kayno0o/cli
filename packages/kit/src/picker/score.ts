export interface Match {
  score: number
  /** The indexes in the text of the characters the query matched, ascending. */
  positions: number[]
}

const MATCH = 16
const CONSECUTIVE = 12
const BOUNDARY = 10
const PREFIX = 8
const GAP = 1
const BOUNDARY_AFTER = new Set([' ', '/', '-', '_', '.', ':', '\\', '(', '[', ',', '\t'])
const UPPER = /\p{Lu}/u
const LOWER = /\p{Ll}/u
const NONE = Number.NEGATIVE_INFINITY

function startsWord(text: string, index: number): boolean {
  if (index === 0)
    return true

  const before = text[index - 1]!

  return BOUNDARY_AFTER.has(before) || (LOWER.test(before) && UPPER.test(text[index]!))
}

/**
 * Fuzzy match of `query` as a subsequence of `text`, on its best alignment: a match on a word start, at the very start or right after the previous match scores higher, each skipped character costs a little.
 * Smart case: a lowercase query ignores case, one uppercase letter makes the whole query exact. Undefined when the query is not a subsequence.
 */
export function fuzzy(query: string, text: string): Match | undefined {
  if (query === '')
    return { score: 0, positions: [] }

  const exact = query !== query.toLowerCase()
  const needle = exact ? query : query.toLowerCase()
  const haystack = exact ? text : text.toLowerCase()

  // Lowercasing can change a text's length (some Unicode letters), and positions would then point elsewhere.
  if (haystack.length !== text.length || needle.length > haystack.length)
    return undefined

  const width = haystack.length
  // best[j][i] is the best score with needle[j] matched at haystack[i], from[j][i] the index needle[j - 1] matched at.
  const best: number[][] = Array.from({ length: needle.length }, () => new Array<number>(width).fill(NONE))
  const from: number[][] = Array.from({ length: needle.length }, () => new Array<number>(width).fill(-1))

  for (let j = 0; j < needle.length; j++) {
    // The best match of the previous character before the one adjacent to i, kept as score + k * GAP so the cost of the gap up to i is read off in one step.
    let run = NONE
    let runAt = -1

    for (let i = j; i < width; i++) {
      if (j > 0 && i - 2 >= j - 1) {
        const candidate = best[j - 1]![i - 2]! + (i - 2) * GAP

        if (candidate > run) {
          run = candidate
          runAt = i - 2
        }
      }

      if (haystack[i] !== needle[j])
        continue

      const here = MATCH + (startsWord(text, i) ? BOUNDARY : 0) + (i === 0 ? PREFIX : 0)

      if (j === 0) {
        best[0]![i] = here - i * GAP

        continue
      }

      const joined = best[j - 1]![i - 1]! + CONSECUTIVE
      const skipped = run - (i - 1) * GAP

      if (joined > NONE && joined >= skipped) {
        best[j]![i] = joined + here
        from[j]![i] = i - 1
      }
      else if (skipped > NONE) {
        best[j]![i] = skipped + here
        from[j]![i] = runAt
      }
    }
  }

  const last = best[needle.length - 1]!
  let end = -1

  for (let i = 0; i < width; i++) {
    if (last[i]! > NONE && (end === -1 || last[i]! > last[end]!))
      end = i
  }

  if (end === -1)
    return undefined

  const positions: number[] = []

  for (let j = needle.length - 1, i = end; j >= 0; j--) {
    positions.unshift(i)
    i = from[j]![i]!
  }

  return { score: last[end]!, positions }
}

export interface Ranked {
  index: number
  positions: number[]
}

/** The lines the query matches, best first, shorter then earlier lines winning a tie; all of them in input order for an empty query. */
export function rank(query: string, lines: readonly string[]): Ranked[] {
  if (query === '')
    return lines.map((_, index) => ({ index, positions: [] }))

  const found: (Ranked & { score: number })[] = []

  for (const [index, line] of lines.entries()) {
    const match = fuzzy(query, line)

    if (match !== undefined)
      found.push({ index, positions: match.positions, score: match.score })
  }

  return found.sort((a, b) => b.score - a.score || lines[a.index]!.length - lines[b.index]!.length || a.index - b.index)
}
