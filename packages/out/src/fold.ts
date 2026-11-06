import { configuredNumber } from '@kaynooo/cli-kit'
import { truncate } from '@kaynooo/utils/text'
import { isImportant, shape } from './shape'

export interface FoldOptions {
  // Output with at most this many lines is left alone.
  threshold: number
  logPath: string
}

// The longest output out leaves untouched unless told otherwise.
export const FOLD_LINES = configuredNumber('out', 'lines', 150)
const HEAD = configuredNumber('out', 'head', 40)
const TAIL = configuredNumber('out', 'tail', 60)
const MAX_BLOCK = 20
const MIN_REFERENCED = 20
// Output over this many bytes per allowed line folds even when it has few lines.
const BYTES_PER_LINE = 55
const MAX_WIDTH = configuredNumber('out', 'width', 300)
const MAX_KEPT_IMPORTANT = 40
const TOP_REPEATED = 3
const LINE_BREAK = /\r\n|\r|\n/
const LINE_END = /(?:\r\n|\r|\n)$/

// A run of one line or a block of several repeated back to back, or a single occurrence when reps is 1.
interface Unit {
  start: number
  size: number
  reps: number
  lines: string[]
  // The last repetition's final line, to show where a run of lookalikes ended.
  last: string
  key: string
  important: boolean
}

// A line of the folded output and how many original lines it stands for.
interface Entry {
  text: string
  important: boolean
  covers: number
}

export function lineCount(text: string): number {
  if (text === '')
    return 0

  const count = text.split(LINE_BREAK).length

  return LINE_END.test(text) ? count - 1 : count
}

export function shouldFold(text: string, threshold: number): boolean {
  return lineCount(text) > threshold || Buffer.byteLength(text) > threshold * BYTES_PER_LINE
}

function cutWide(line: string): string {
  return line.length > MAX_WIDTH ? `${line.slice(0, MAX_WIDTH)}... [+${line.length - MAX_WIDTH} chars]` : line
}

// A carriage return rewrites the line, so only what follows the last one is left.
function finalState(line: string): string {
  const segments = line.split('\r').filter(segment => segment !== '')

  return segments.at(-1) ?? ''
}

function splitLines(text: string): string[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n').map(line => (line.includes('\r') ? finalState(line) : line))

  return text.endsWith('\n') ? lines.slice(0, -1) : lines
}

function repeats(keys: string[], at: number, size: number): boolean {
  if (keys[at] !== keys[at + size])
    return false

  for (let offset = 1; offset < size; offset++) {
    if (keys[at + offset] !== keys[at + size + offset])
      return false
  }

  return true
}

// Groups the lines into units, taking at each position the repeat (1 to MAX_BLOCK lines, back to back) that covers the most lines.
function toUnits(lines: string[], keys: string[]): Unit[] {
  const units: Unit[] = []

  for (let at = 0; at < lines.length;) {
    let size = 1
    let reps = 1

    for (let candidate = 1; candidate <= MAX_BLOCK && at + candidate * 2 <= lines.length; candidate++) {
      let count = 1

      while (at + (count + 1) * candidate <= lines.length && repeats(keys, at + (count - 1) * candidate, candidate))
        count++

      if (count > 1 && candidate * count > size * reps) {
        size = candidate
        reps = count
      }
    }

    const slice = lines.slice(at, at + size)

    units.push({
      start: at,
      size,
      reps,
      lines: slice,
      last: lines[at + size * reps - 1] ?? '',
      key: keys.slice(at, at + size).join('\n'),
      important: slice.some(line => isImportant(line)),
    })

    at += size * reps
  }

  return units
}

function clip(line: string, width = 100): string {
  const trimmed = line.trim()

  return truncate(trimmed, width)
}

function toEntries(units: Unit[]): { entries: Entry[], references: boolean, repeated: string[] } {
  const entries: Entry[] = []
  const firstSeen = new Map<string, number>()
  const counts = new Map<string, { count: number, sample: string }>()
  let references = false

  for (const unit of units) {
    const seen = counts.get(unit.key)

    counts.set(unit.key, { count: (seen?.count ?? 0) + unit.reps, sample: seen?.sample ?? clip(unit.lines[0] ?? '') })

    const earlier = firstSeen.get(unit.key)
    const covers = unit.size * unit.reps

    if (earlier !== undefined && (unit.size > 1 || unit.key.length >= MIN_REFERENCED)) {
      references = true

      const where = unit.size > 1 ? `block same as line ${earlier}` : `same as line ${earlier}`
      const times = unit.reps > 1 ? `, repeated ${unit.reps} times` : ''
      const prefix = unit.important ? `${clip(unit.lines[0] ?? '')} ` : ''

      entries.push({ text: `${prefix}(${where}${times})`, important: unit.important, covers })

      continue
    }

    firstSeen.set(unit.key, unit.start + 1)

    if (unit.reps === 1) {
      entries.push(...unit.lines.map(text => ({ text, important: unit.important, covers: 1 })))

      continue
    }

    if (unit.size === 1) {
      const first = unit.lines[0] ?? ''
      const ending = unit.last === first ? '' : `, last: ${clip(unit.last)}`

      entries.push({ text: `${first} (x${unit.reps}${ending})`, important: unit.important, covers })

      continue
    }

    entries.push(...unit.lines.map(text => ({ text, important: unit.important, covers: unit.reps })))
    entries.push({ text: `(block repeated ${unit.reps} times)`, important: unit.important, covers: 0 })
  }

  const repeated = [...counts.values()]
    .filter(({ count }) => count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_REPEATED)
    .map(({ count, sample }) => `${count}x ${sample}`)

  return { entries, references, repeated }
}

// Folds long output: drops carriage-return progress, collapses repeated lines and blocks (compared by shape) and far-apart duplicates, then keeps the head, the tail and the important lines of the middle.
export function fold(text: string, { threshold, logPath }: FoldOptions): string {
  const lines = splitLines(text)
  const { entries, references, repeated } = toEntries(toUnits(lines, lines.map(line => shape(line))))

  for (const entry of entries)
    entry.text = cutWide(entry.text)

  const heavy = entries.reduce((sum, { text }) => sum + text.length + 1, 0) > threshold * BYTES_PER_LINE
  const shrink = heavy && entries.length <= threshold ? 2 : 1
  const head = Math.floor(Math.min(HEAD, Math.floor(threshold / 3)) / shrink)
  const tail = Math.floor(Math.min(TAIL, Math.floor(threshold / 2)) / shrink)
  const out: string[] = []
  let dropped = 0
  let kept = 0

  if (entries.length <= threshold && !heavy) {
    out.push(...entries.map(({ text }) => text))
  }
  else {
    const middleEnd = entries.length - tail
    let gap = 0

    const closeGap = () => {
      if (gap > 0)
        out.push(`[out: ${gap} lines left out]`)

      dropped += gap
      gap = 0
    }

    for (const [index, entry] of entries.entries()) {
      if (index < head || index >= middleEnd) {
        closeGap()
        out.push(entry.text)

        continue
      }

      if (entry.important && kept < MAX_KEPT_IMPORTANT) {
        kept++
        closeGap()
        out.push(entry.text)

        continue
      }

      gap += entry.covers
    }

    closeGap()
  }

  const note = references ? ' (line numbers in "same as line N" refer to it)' : ''
  const header = [`[out: ${lines.length} lines, ${dropped} left out, full log: ${logPath}${note}]`]

  if (repeated.length > 0)
    header.push(`[out: most repeated: ${repeated.join(', ')}]`)

  return `${[...header, ...out].join('\n')}\n`
}
