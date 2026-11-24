import process from 'node:process'
import { stripAnsi, toolExcerpt } from '@kaynooo/cli-kit'
import { formatError, parseErrors } from '@kaynooo/cli-kit/errors'

// A line bun test writes between one test's output and the next: a result, or a file's header, as a parallel run prints it locally and CI groups it.
const BOUNDARY = /^(?:\((?:pass|fail|skip|todo)\) |::(?:end)?group::|\S+\.test\.[jt]sx?:$)/
const DURATION = / \[[\d.]+m?s\]$/
const FAIL = '(fail) '
const PASS = '(pass) '
const MAX_TESTS = 10
const MAX_ERRORS = 40
// Forgejo/GitHub timestamp prefix, plus GitLab runner timestamp + stream + section markers.
const GITLAB_PREFIX = /^\d{4}-\d\d-\d\dT[\d:.]+Z \d\d[EO]\+? ?/
const GITLAB_SECTION = /section_(?:start|end):\d+:[\w.-]+/g
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /
const TRAILING_CR = /\r+$/
// The line act writes when a step fails, the step's name after it.
const FAILED_STEP = /❌\s+Failure - Main /
const GITLAB_JOB_FAILED = /^ERROR: Job failed/
// Lines of a failed step shown above its failure, which name its error and, for tests, list the failed ones.
const STEP_TAIL = 30
const TAIL = 40
// How far above its failure line a step's own output is looked for a tool's errors.
const TOOL_WINDOW = 200

export function logLines(log: string): string[] {
  return log.split('\n').map((raw) => {
    const line = raw.replace(GITLAB_PREFIX, '').replace(STAMP, '').replace(GITLAB_SECTION, '').replace(TRAILING_CR, '')

    return stripAnsi(line.slice(line.lastIndexOf('\r') + 1)).trimEnd()
  })
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

// Structured error parsing shared with `errs` across Forgejo, GitHub, and GitLab logs.
function structuredErrors(lines: string[]): string | undefined {
  const { errors } = parseErrors(lines.join('\n'))
  const relevant = errors.filter(error => error.severity === 'error')
  const list = relevant.length > 0 ? relevant : errors

  if (list.length === 0)
    return undefined

  const shown = list.slice(0, MAX_ERRORS).map(error => formatError(error, process.cwd()))

  if (list.length > MAX_ERRORS)
    shown.push(`… ${list.length - MAX_ERRORS} more errors`)

  return shown.join('\n')
}

// What a failed job's log says: each failed test's output, then the end of each failed step (parsed via shared `errs` collectors or toolExcerpt), else structured errors across the whole log, else the log's last lines.
export function excerpt(log: string): string {
  const lines = logLines(log)
  const parts = failedTests(lines)
  const gitlabVerdict = lines.findLast(line => GITLAB_JOB_FAILED.test(line))

  for (const [index, line] of lines.entries()) {
    if (FAILED_STEP.test(line)) {
      const window = lines.slice(Math.max(0, index - TOOL_WINDOW), index)
      const parsed = toolExcerpt(window) ?? (parts.length === 0 ? structuredErrors(window) : undefined)

      parts.push(parsed ?? lines.slice(Math.max(0, index - STEP_TAIL), index + 1).filter(text => text.trim() !== '' && !text.startsWith(PASS) && !text.startsWith('::')).join('\n'))
    }
  }

  if (parts.length > 0)
    return parts.join('\n\n')

  const parsed = structuredErrors(lines)

  if (parsed !== undefined)
    return gitlabVerdict === undefined ? parsed : `${parsed}\n\n${gitlabVerdict}`

  const tail = lines.filter(line => line.trim() !== '' && !line.startsWith('::')).slice(-TAIL).join('\n').trim()

  return tail
}
