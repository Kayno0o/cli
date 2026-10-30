import { stripAnsi } from '@kaynooo/cli-kit'

export interface TraceLine { text: string, section: string }

// What a runner writes before each line: its time, the stream, and a + on a line it split; older runners write none.
const PREFIX = /^\d{4}-\d\d-\d\dT[\d:.]+Z \d\d[EO]\+? ?/
const SECTION = /section_(start|end):\d+:([\w.-]+)/g
const TRAILING_CR = /\r+$/
const JOB_FAILED = /^ERROR: Job failed/
// PHPUnit's and paratest's lists of failed tests, each test numbered, ending on the verdict and its counts.
const FAILED_LIST = /^There (?:was 1|were \d+) (?:error|failure)s?:$/
const OTHER_LIST = /^There (?:was 1|were \d+) /
const NUMBERED = /^\d+\) /
// A stack frame inside a dependency, which says nothing about the test.
const VENDOR_FRAME = /^\S*\/vendor\/\S+:\d+$/
const VERDICT = /^(?:FAILURES|ERRORS)!$/
const MAX_TESTS = 10
const TEST_LINES = 15
const TAIL = 40

// The trace as a terminal shows it: prefixes, colours and lines a carriage return overwrote dropped, each line tagged with the section it ran in.
export function traceLines(trace: string): TraceLine[] {
  const lines: TraceLine[] = []
  let section = ''

  for (const raw of trace.split('\n')) {
    const line = raw.replace(PREFIX, '').replace(TRAILING_CR, '')
    let marked = false

    for (const [, edge, name] of line.matchAll(SECTION)) {
      marked = true
      section = edge === 'start' ? name ?? '' : ''
    }

    const shown = line.replace(SECTION, '')
    const text = stripAnsi(shown.slice(shown.lastIndexOf('\r') + 1)).trimEnd()

    if (!marked || text !== '')
      lines.push({ text, section })
  }

  return lines
}

function trimBlank(lines: string[]): string[] {
  const start = lines.findIndex(line => line.trim() !== '')

  return start === -1 ? [] : lines.slice(start, lines.findLastIndex(line => line.trim() !== '') + 1)
}

// Each failed PHPUnit test, cut to its first lines with dependency frames left out, then the verdict; empty when the trace lists none.
export function failedTests(texts: string[]): string[] {
  const parts: string[] = []
  let listing = false
  let tests = 0
  let current: string[] = []
  let verdict: string | undefined

  function close(): void {
    const kept = trimBlank(current)

    if (kept.length > 0 && tests <= MAX_TESTS)
      parts.push([...kept.slice(0, TEST_LINES), ...kept.length > TEST_LINES ? [`… ${kept.length - TEST_LINES} more lines`] : []].join('\n'))

    current = []
  }

  for (const [index, text] of texts.entries()) {
    if (FAILED_LIST.test(text)) {
      close()
      listing = true
      parts.push(text)
    }
    else if (VERDICT.test(text) || OTHER_LIST.test(text)) {
      close()
      listing = false

      if (VERDICT.test(text))
        verdict = trimBlank(texts.slice(index, index + 2)).join('\n')
    }
    else if (listing && NUMBERED.test(text)) {
      close()
      tests++
      current.push(text)
    }
    else if (listing && current.length > 0 && !VENDOR_FRAME.test(text)) {
      current.push(text)
    }
  }

  close()

  if (tests === 0)
    return []

  if (tests > MAX_TESTS)
    parts.push(`and ${tests - MAX_TESTS} more failed tests`)

  return verdict === undefined ? parts : [...parts, verdict]
}

// What a failed job's trace says: each failed test, else the last lines of the script that failed, then the runner's verdict.
export function excerpt(trace: string): string {
  const lines = traceLines(trace)
  const verdict = lines.findLast(line => JOB_FAILED.test(line.text))?.text
  const script = lines.findLast(line => line.section.startsWith('step_'))?.section
  const ran = lines.filter(line => line.text !== verdict && (script === undefined ? !line.section.startsWith('cleanup') : line.section === script)).map(line => line.text)
  const tests = failedTests(ran)
  const body = tests.length > 0 ? tests.join('\n\n') : trimBlank(ran.slice(-TAIL)).join('\n')

  return verdict === undefined ? body : `${body}\n\n${verdict}`
}
