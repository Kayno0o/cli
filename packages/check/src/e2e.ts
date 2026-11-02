import type { Collector, ToolError } from './output'

// Headers and totals Playwright and Vitest print around their errors.
export const E2E_NOISE: RegExp[] = [
  /^(?:Running \d+ tests? using|\(node:\d+\) Warning|\(Use `node|\[\d+\/\d+\] |\s+[-✓✘°×]\s+\d+|To open last HTML|Serving HTML report|\s*npx playwright show-report)/,
  /^[·F×°T±]+$/,
  /^(?: RUN {2}v|\s*[❯✓×↓] |\s+(?:Test Files|Tests|Start at|Duration|Errors) {2}|⎯)/,
]

const PLAYWRIGHT_HEADER = /^ {2}\d+\) (?:\[([^\]]+)\] › )?(.+?):(\d+):(\d+) › (.+?) ─+$/
const PLAYWRIGHT_SUMMARY = /^ {2}\d+ (failed|flaky|passed|skipped|did not run|interrupted)\b/
const PLAYWRIGHT_ENTRY = /^ {4}(?:\[([^\]]+)\] › )?(.+?):(\d+):(\d+) › (.+?) ─+$/
const PLAYWRIGHT_RETRY = /^\s+Retry #\d+ ─+$/
const FRAME = /^\s+at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/
const EXPECTED = /^\s+Expected: (.*)$/
const RECEIVED = /^\s+Received: (.*)$/
const VITEST_FAIL = /^ FAIL {2}(?:\|[^|]+\| )?(.+)$/
const VITEST_SUITE = /^(.+?) \[ .+ \]$/
const VITEST_FRAME = /^\s*❯ (\S+):(\d+):(\d+)$/

function key(project: string | undefined, file: string | undefined, line: string | undefined, column: string | undefined, title: string | undefined): string {
  return `${project ?? ''}|${file}:${line}:${column} › ${title}`
}

// The first stack frame outside node_modules.
function firstFrame(block: string[]): RegExpExecArray | undefined {
  return block.map(line => FRAME.exec(line)).find(match => match !== null && !match[1]?.includes('node_modules')) ?? undefined
}

// Playwright's list and line reporters: each numbered failure with its first error line, a test that passed on retry (listed under "flaky" in the totals) left out.
export const collectPlaywright: Collector = (lines, used) => {
  const flaky = new Set<string>()
  let section = ''

  for (const [index, line] of lines.entries()) {
    const summary = PLAYWRIGHT_SUMMARY.exec(line)
    const entry = PLAYWRIGHT_ENTRY.exec(line)

    if (summary !== null) {
      section = summary[1] ?? ''
      used.add(index)
    }
    else if (entry !== null && section !== '') {
      if (section === 'flaky')
        flaky.add(key(entry[1], entry[2], entry[3], entry[4], entry[5]))

      used.add(index)
    }
  }

  const errors: ToolError[] = []

  for (let index = 0; index < lines.length; index++) {
    const header = PLAYWRIGHT_HEADER.exec(lines[index] ?? '')

    if (header === null)
      continue

    let end = index + 1

    while (end < lines.length && !PLAYWRIGHT_HEADER.test(lines[end] ?? '') && !PLAYWRIGHT_SUMMARY.test(lines[end] ?? ''))
      end++

    for (let at = index; at < end; at++)
      used.add(at)

    const [, project, file, line, column, title] = header
    const retry = lines.findIndex((text, at) => at > index && at < end && PLAYWRIGHT_RETRY.test(text))
    const block = lines.slice(index + 1, retry === -1 ? end : retry)
    const frame = firstFrame(block)
    const message = block.find(text => text.trim() !== '')?.trim() ?? 'failed'
    const expected = block.map(text => EXPECTED.exec(text)?.[1]?.trim()).find(text => text !== undefined)
    const received = block.map(text => RECEIVED.exec(text)?.[1]?.trim()).find(text => text !== undefined)
    const values = expected === undefined || received === undefined ? '' : ` (expected ${expected}, received ${received})`

    index = end - 1

    if (flaky.has(key(project, file, line, column, title)))
      continue

    errors.push({ tool: 'playwright', file: frame?.[1] ?? file ?? '', line: Number(frame?.[2] ?? line), column: Number(frame?.[3] ?? column), severity: 'error', message: `${message}${values}`, test: `${project === undefined ? '' : `[${project}] `}${title}` })
  }

  return errors
}

// Vitest's failure blocks, from the ` FAIL  file > suite > test` line to the next rule of ⎯: the first line of the error, at the first ` ❯ file:line:col` frame. A suite that failed to load has no test.
export const collectVitest: Collector = (lines, used) => {
  const errors: ToolError[] = []

  for (let index = 0; index < lines.length; index++) {
    const header = VITEST_FAIL.exec(lines[index] ?? '')?.[1]

    if (header === undefined)
      continue

    let end = index + 1

    while (end < lines.length && !(lines[end] ?? '').startsWith('⎯') && !VITEST_FAIL.test(lines[end] ?? ''))
      end++

    for (let at = index; at < end; at++)
      used.add(at)

    const block = lines.slice(index + 1, end)
    const frame = block.map(text => VITEST_FRAME.exec(text)).find(match => match !== null && !match[1]?.includes('node_modules'))
    const suite = VITEST_SUITE.exec(header)?.[1]
    const [file = '', ...names] = (suite ?? header).split(' > ')

    errors.push({ tool: 'vitest', file: frame?.[1] ?? file, line: Number(frame?.[2] ?? 0), column: Number(frame?.[3] ?? 0), severity: 'error', message: block.find(text => text.trim() !== '')?.trim() ?? 'failed', ...(suite === undefined && names.length > 0 ? { test: names.join(' > ') } : {}) })
    index = end - 1
  }

  return errors
}
