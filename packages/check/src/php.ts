import type { Collector, ToolError } from './output'

// Headers and totals PHPUnit, ParaTest, PHPStan and PHP CS Fixer print around their errors.
export const PHP_NOISE: RegExp[] = [
  /^(?:PHPUnit \d|ParaTest v|Runtime: |Configuration: |Processes: |Random Seed: |Time: |Tests: |OK(?:,| \()|FAILURES!|ERRORS!|WARNINGS!|No tests executed|--$)/,
  /^[.FEWRISD]+\s+\d+ \/ \d+ \(\d+%\)$/,
  /^ -{3,}(?: -{3,})*\s*$/,
  /^\s*\d+\/\d+ \[[=>\-▓░ ]*\]\s+\d+%/,
  /^(?:Note: Using configuration file|\s*\[(?:OK|ERROR)\] )/,
  /^(?:Loaded config|PHP runtime:|PHP CS Fixer \d|Running analysis|Parallel runner|Using cache file|Paths from configuration|Rules from configuration|Setting PHP_CS_FIXER|Unable to determine minimum|If you need help|Found \d+ of \d+ files|Checked all files|Fixed \d+ of \d+ files|Legend:)/,
]

const MAX_DIFF_LINES = 6
const PHPUNIT_HEADER = /^There (?:was|were) \d+ ([a-z ]+?)s?:$/i
const PHPUNIT_TRIGGERED = /^\d+ tests? triggered \d+ [\w ]+?s?:$/
const PHPUNIT_END = /^(?:--|FAILURES!|ERRORS!|WARNINGS!|OK\b.*|Tests: .*|No tests executed!)$/
const PHPUNIT_ITEM = /^\d+\) (.*)$/
const PHP_LOCATION = /^([\w./-]+\.php):(\d+)$/
const PHPSTAN_FILE = /^ {2}Line {3}(\S.*)$/
const PHPSTAN_GENERAL = /^ {2}Error\s*$/
const PHPSTAN_MESSAGE = /^ {2}(\S.*)$/
const PHPSTAN_ROW = /^ {2}(\d+|-) +(\S.*)$/
const PHPSTAN_CONTINUATION = /^ {9}(\S.*)$/
const PHPSTAN_IDENTIFIER = /^ {9}🪪\s+(\S+)\s*$/
const PHPSTAN_TIP = /^ {9}💡/
const PHPSTAN_BORDER = /^ -{3,}(?: -{3,})*\s*$/
const PHPSTAN_RAW = /^(\S.*?\.(?:php|phtml|twig|neon|inc)):(\d+):(\S.*)$/
const PHPSTAN_JSON = /^\{.*"totals"/
const CS_FIXER_FILE = /^\s+\d+\) (\S.*?\.php)(?: \((.+)\))?$/
const CS_FIXER_DIFF_START = /^\s+-+ begin diff -+$/
const CS_FIXER_DIFF_END = /^\s+-+ end diff -+$/

function isHeader(line: string): boolean {
  return PHPUNIT_HEADER.test(line) || PHPUNIT_TRIGGERED.test(line)
}

// The changed lines of a PHPUnit diff, cut to a few.
function diffSummary(message: string[]): string {
  const start = message.findIndex(line => line === '+++ Actual')

  if (start === -1)
    return ''

  const changed = message.slice(start + 1).filter(line => line.startsWith('-') || line.startsWith('+')).map(line => `${line[0]} ${line.slice(1).trim()}`)
  const shown = changed.slice(0, MAX_DIFF_LINES).join(' | ')

  return changed.length === 0 ? '' : ` (${shown}${changed.length > MAX_DIFF_LINES ? ' | ...' : ''})`
}

function phpunitError(test: string, body: string[]): ToolError {
  const at = body.findIndex(line => PHP_LOCATION.test(line))
  const location = PHP_LOCATION.exec(body[at] ?? '')
  const message = body.slice(0, at === -1 ? body.length : at).map(line => line.trimEnd())
  const first = message.find(line => line.trim() !== '') ?? 'failed'

  return { tool: 'phpunit', file: location?.[1] ?? '', line: Number(location?.[2] ?? 0), column: 0, severity: 'error', message: `${first}${diffSummary(message)}`, test }
}

// PHPUnit 9 to 12 and ParaTest: the numbered items of the "There was 1 error" and "There were 3 failures" sections, located at the first file:line under each. Risky tests, warnings, deprecations and the like are read but never counted.
export const collectPhpunit: Collector = (lines, used) => {
  const errors: ToolError[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const kind = PHPUNIT_HEADER.exec(line)?.[1]

    if (kind === undefined && !PHPUNIT_TRIGGERED.test(line))
      continue

    let end = index + 1

    while (end < lines.length && !PHPUNIT_END.test(lines[end] ?? '') && !isHeader(lines[end] ?? ''))
      end++

    for (let at = index; at < end; at++)
      used.add(at)

    if (kind === 'error' || kind === 'failure') {
      const starts = Array.from({ length: end - index - 1 }, (_, at) => index + 1 + at).filter(at => PHPUNIT_ITEM.test(lines[at] ?? ''))

      for (const [position, start] of starts.entries())
        errors.push(phpunitError(PHPUNIT_ITEM.exec(lines[start] ?? '')?.[1] ?? '', lines.slice(start + 1, starts[position + 1] ?? end)))
    }

    index = end - 1
  }

  return errors
}

function appendMessage(error: ToolError, text: string): void {
  error.message = `${error.message} ${text}`
}

function phpstanJson(text: string): { file: string, line: number, message: string, rule?: string }[] | undefined {
  try {
    const report = JSON.parse(text) as { files?: Record<string, { messages: { message: string, line?: number | null, identifier?: string }[] }>, errors?: string[] }
    const fromFiles = Object.entries(report.files ?? {}).flatMap(([file, entry]) => entry.messages.map(message => ({ file, line: message.line ?? 0, message: message.message, ...(message.identifier === undefined ? {} : { rule: message.identifier }) })))

    return [...fromFiles, ...(report.errors ?? []).map(message => ({ file: '', line: 0, message }))]
  }
  catch {
    return undefined
  }
}

// PHPStan's table (the default), its raw `file:line:message` lines and its one-line JSON report.
export const collectPhpstan: Collector = (lines, used) => {
  const errors: ToolError[] = []
  let file: string | undefined
  let current: ToolError | undefined
  let rows = 0
  let tip = false
  // The "Error" table of problems with no file, one message per line.
  let general = false

  for (const [index, text] of lines.entries()) {
    const line = text.trimEnd()

    if (used.has(index))
      continue

    if (PHPSTAN_JSON.test(line)) {
      const parsed = phpstanJson(line)

      for (const entry of parsed ?? []) {
        errors.push({ tool: 'phpstan', file: entry.file, line: entry.line, column: 0, severity: 'error', message: entry.message, ...(entry.rule === undefined ? {} : { rule: entry.rule }) })
      }

      if (parsed !== undefined)
        used.add(index)

      continue
    }

    const raw = PHPSTAN_RAW.exec(line)

    if (raw !== null) {
      errors.push({ tool: 'phpstan', file: raw[1] ?? '', line: Number(raw[2]), column: 0, severity: 'error', message: raw[3] ?? '' })
      used.add(index)

      continue
    }

    const header = PHPSTAN_FILE.exec(line)

    if (header !== null || PHPSTAN_GENERAL.test(line)) {
      file = header?.[1] ?? ''
      general = header === null
      current = undefined
      rows = 0
      used.add(index)

      continue
    }

    if (file === undefined)
      continue

    const message = PHPSTAN_MESSAGE.exec(line)?.[1]

    if (general && message !== undefined && !PHPSTAN_BORDER.test(line)) {
      errors.push({ tool: 'phpstan', file: '', line: 0, column: 0, severity: 'error', message })
      rows++
      used.add(index)

      continue
    }

    const row = PHPSTAN_ROW.exec(line)
    const identifier = PHPSTAN_IDENTIFIER.exec(line)?.[1]
    const continuation = PHPSTAN_CONTINUATION.exec(line)?.[1]

    if (PHPSTAN_BORDER.test(line) && rows > 0) {
      file = undefined
      general = false
      current = undefined
    }
    else if (row !== null) {
      current = { tool: 'phpstan', file, line: row[1] === '-' ? 0 : Number(row[1]), column: 0, severity: 'error', message: row[2] ?? '' }
      errors.push(current)
      rows++
      tip = false
      used.add(index)
    }
    else if (identifier !== undefined && current !== undefined) {
      current.rule = identifier
      used.add(index)
    }
    else if (PHPSTAN_TIP.test(line)) {
      tip = true
      used.add(index)
    }
    else if (continuation !== undefined && current !== undefined) {
      if (!tip)
        appendMessage(current, continuation)

      used.add(index)
    }
  }

  return errors
}

// PHP CS Fixer's dry-run listing: one error per file, the fixers it names as the rule, its --diff blocks skipped.
export const collectCsFixer: Collector = (lines, used) => {
  const errors: ToolError[] = []

  for (let index = 0; index < lines.length; index++) {
    const match = CS_FIXER_FILE.exec(lines[index] ?? '')

    if (match === null)
      continue

    errors.push({ tool: 'php-cs-fixer', file: match[1] ?? '', line: 0, column: 0, ...(match[2] === undefined ? {} : { rule: match[2] }), severity: 'error', message: 'style issues to fix' })
    used.add(index)

    if (!CS_FIXER_DIFF_START.test(lines[index + 1] ?? ''))
      continue

    const end = lines.findIndex((text, at) => at > index && CS_FIXER_DIFF_END.test(text))

    for (let at = index + 1; at <= (end === -1 ? index + 1 : end); at++)
      used.add(at)

    index = end === -1 ? index + 1 : end
  }

  return errors
}
