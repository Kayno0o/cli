import { toolExcerpt } from '@kaynooo/cli-kit'

// A line bun test writes between one test's output and the next: a result, or a file's header, as a parallel run prints it locally and CI groups it.
const BOUNDARY = /^(?:\((?:pass|fail|skip|todo)\) |::(?:end)?group::|\S+\.test\.[jt]sx?:$)/
const DURATION = / \[[\d.]+m?s\]$/
const FAIL = '(fail) '
const PASS = '(pass) '
const MAX_TESTS = 10
const STAMP = /^\S+Z /
// The line act writes when a step fails, the step's name after it.
const FAILED_STEP = /❌\s+Failure - Main /
// Lines of a failed step shown above its failure, which name its error and, for tests, list the failed ones.
const STEP_TAIL = 30
const TAIL = 40
// How far above its failure line a step's own output is looked for a tool's errors.
const TOOL_WINDOW = 200

export function logLines(log: string): string[] {
  return log.split('\n').map(line => line.replace(STAMP, ''))
}

// Each failed bun test's own output, from the line after the previous boundary down to its `(fail)` line, once per test as bun test lists them again by name at the end.
export function failedTests(lines: string[]): string[] {
  const seen = new Set<string>()
  const blocks: string[] = []

  for (const [index, line] of lines.entries()) {
    const name = line.replace(DURATION, '')

    if (!line.startsWith(FAIL) || seen.has(name))
      continue

    seen.add(name)

    if (blocks.length < MAX_TESTS)
      blocks.push(lines.slice(lines.findLastIndex((text, at) => at < index && BOUNDARY.test(text)) + 1, index + 1).filter(text => !text.startsWith('::')).join('\n').trim())
  }

  if (seen.size > MAX_TESTS)
    blocks.push(`and ${seen.size - MAX_TESTS} more failed tests`)

  return blocks
}

// What a failed job's log says: each failed test's output, then the end of each failed step, cut to a recognised tool's errors or with passing tests left out, else the log's last lines.
export function excerpt(log: string): string {
  const lines = logLines(log)
  const parts = failedTests(lines)

  for (const [index, line] of lines.entries()) {
    if (FAILED_STEP.test(line))
      parts.push(toolExcerpt(lines.slice(Math.max(0, index - TOOL_WINDOW), index)) ?? lines.slice(Math.max(0, index - STEP_TAIL), index + 1).filter(text => text.trim() !== '' && !text.startsWith(PASS) && !text.startsWith('::')).join('\n'))
  }

  return parts.length === 0 ? lines.slice(-TAIL).join('\n').trim() : parts.join('\n\n')
}
