// eslint-disable-next-line no-control-regex
const ANSI = /\x1B\[[\d;?]*[A-Z]/gi
const HEX_LITERAL = /\b0x[0-9a-f]+\b/gi
const PATH = /(?:\.{1,2}\/|\/)?[\w.@~-]+(?:\/[\w.@~-]+)+/g
const FILE = /\b[\w@~-]+(?:\.[\w-]+)*\.[a-z]\w{0,5}\b/gi
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|µs|ns|[smh])\b/g
const PERCENT = /\b\d+(?:\.\d+)?%/g
const NUMBER = /\d+(?:\.\d+)?/g
const IMPORTANT = /error|fail|warn|panic|exception|fatal|✗|✘|^\s+at\s+\S|^\s*File ".*", line \d+|^\s*\d+: .+ at /i

export function stripAnsi(line: string): string {
  return line.replaceAll(ANSI, '')
}

// Whether the line carries an error, failure, warning or stack frame, which folding never drops.
export function isImportant(line: string): boolean {
  return IMPORTANT.test(stripAnsi(line))
}

// The line with what changes between lookalikes (numbers, ids, durations, paths, file names) replaced by placeholders.
export function shape(line: string): string {
  return stripAnsi(line)
    .replaceAll(HEX_LITERAL, '<hex>')
    .replaceAll(PATH, '<path>')
    .replaceAll(FILE, '<file>')
    .replaceAll(HASH, '<hex>')
    .replaceAll(DURATION, '<time>')
    .replaceAll(PERCENT, '<pct>')
    .replaceAll(NUMBER, '<n>')
    .trimEnd()
}
