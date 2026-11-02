import { stripAnsi } from '@kaynooo/cli-kit'

const HEX_LITERAL = /\b0x[0-9a-f]+\b/gi
const PATH = /(?:\.{1,2}\/|\/)?[\w.@~-]+(?:\/[\w.@~-]+)+/g
const FILE = /\b[\w@~-]+(?:\.[\w-]+)*\.[a-z]\w{0,5}\b/gi
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|µs|ns|[smh])\b/g
const PERCENT = /\b\d+(?:\.\d+)?%/g
const NUMBER = /\d+(?:\.\d+)?/g
// Longer lines are cut before the regexes below run, which backtrack quadratically on a long run of dots or slashes.
const MAX_SHAPED = 2000
const IMPORTANT = /error|fail|warn|panic|exception|fatal|✗|✘|^\s+at\s+\S|^\s*File ".*", line \d+|^\s*\d+: .+ at /i

// Whether the line carries an error, failure, warning or stack frame, which folding never drops.
export function isImportant(line: string): boolean {
  return IMPORTANT.test(stripAnsi(line.slice(0, MAX_SHAPED)))
}

// The line with what changes between lookalikes (numbers, ids, durations, paths, file names) replaced by placeholders.
export function shape(line: string): string {
  return stripAnsi(line.slice(0, MAX_SHAPED))
    .replaceAll(HEX_LITERAL, '<hex>')
    .replaceAll(PATH, '<path>')
    .replaceAll(FILE, '<file>')
    .replaceAll(HASH, '<hex>')
    .replaceAll(DURATION, '<time>')
    .replaceAll(PERCENT, '<pct>')
    .replaceAll(NUMBER, '<n>')
    .trimEnd()
}
