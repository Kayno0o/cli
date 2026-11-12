import { bunCheckFields, LOG_PATTERNS, stripAnsi } from '@kaynooo/cli-kit'
import { collectPlaywright, collectVitest, E2E_NOISE } from './e2e'
import { collectCsFixer, collectPhpstan, collectPhpunit, PHP_NOISE } from './php'

const { BASH_ECHO, DURATION, BOUNDARY, BUN_TEST_SUMMARY, BUN_CHECK_SUMMARY, TSC_CONTINUATION, TSC_FRAME, TSC_SUMMARY, ESLINT_PROBLEM, ESLINT_SUMMARY } = LOG_PATTERNS

export interface ToolError {
  tool: 'tsc' | 'eslint' | 'bun check' | 'kay check' | 'bun test' | 'phpunit' | 'phpstan' | 'php-cs-fixer' | 'playwright' | 'vitest' | 'go' | 'cargo' | 'ruff' | 'pytest' | 'generic'
  file: string
  line: number
  column: number
  rule?: string | undefined
  severity: 'error' | 'warning'
  message: string
  test?: string
}

export interface ParsedErrors { errors: ToolError[], unrecognised: number }

const TSC_PLAIN_ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/
const TSC_PRETTY_ERROR = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/
const TSC_SOURCE_LINE = /^\d+ /
const ESLINT_FIELDS = /^ +(\d+):(\d+) +(error|warning) +(\S.*)$/
const ESLINT_RULE = / {2,}(\S+)$/
// The path line opening a file's problems: absolute, home or dot relative (spaces allowed), or a word holding a separator.
const ESLINT_FILE = /^(?:\/|~\/|\.{1,2}[/\\]|[a-z]:\\)|^[^\s/\\]+[/\\]\S*$/i
const BUN_TEST_EXPECTED = /^Expected: (.*)$/
const BUN_TEST_RECEIVED = /^Received: (.*)$/
const BUN_TEST_FRAME = /^\s+at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/
const BUN_TEST_FILE = /^\S+\.test\.[jt]sx?:$/
const GO_ERROR = /^\s*(?:vet: )?(\S+\.go):(\d+):(?:(\d+):)? (.+)$/
const GO_LINTER = /^(.*\S)\s+\(([a-z][\w-]*)\)$/
const GO_NOISE = /^# \S+(?: \[\S+\])?$/
const ARROW = /^\s*--> (.+?):(\d+):(\d+)$/
const CARGO_HEADER = /^(error|warning)(?:\[([\w-]+)\])?: (.*)$/
// The lines a message runs on under its header, indented, as kay check prints a TypeScript message chain.
const CONTINUATION = /^\s+\S/
const MAX_CONTINUATION = 20
const KAY_SUMMARY = /^(?:\d+ errors?(?:, \d+ warnings?)?|\d+ warnings?)(?:, failing under --deny-warnings)?$|^checked with /
const CARGO_NOISE = /^(?:\s+(?:Compiling|Finished|Checking|Fresh|Running|Blocking) |error: (?:aborting due to|could not compile)|warning: .* generated \d+ warnings?|Some errors have detailed explanations|For more information about (?:this|an) error|To learn more, run the command again)/
const RUFF_CONCISE = /^(\S+\.pyi?):(\d+):(\d+): ([A-Z]+\d+) (?:\[\*\] )?(.*)$/
const RUFF_HEADER = /^([A-Z]{1,5}\d{1,4}) (?:\[\*\] )?(.+)$/
const RUFF_NOISE = /^(?:Found \d+ errors?\.|\[\*\] \d+ fixable|No fixes available|All checks passed|help: |\s*(?:\|\s*)?$)/
const PYTEST_LOCATION = /^(\S+\.py):(\d+): (\S.*)$/
const PYTEST_E_LINE = /^E {3}(.*)$/
const PYTEST_BANNER = /^={3,} (.*?) ={3,}$/
const PYTEST_FAILURES = new Set(['FAILURES', 'ERRORS'])
const PYTEST_SUMMARY_LINE = /^(?:FAILED|ERROR) \S/
const PYTEST_FRAME = /^in \S/
const PYTEST_SECTION = /^_{3,} .* _{3,}$/
const PYTEST_EXCEPTION_END = /[\s:]/
const PYTEST_NOISE = /^(?:platform |rootdir: |collected |plugins: |configfile: |cachedir: |\S+\.pyi? [.FEsxXR]+ +\[ *\d+%\]$|\S+\.py:\d+: $)/
// The `file:line[:col]: error|warning|note: message` line gcc, clang, mypy, `shellcheck -f gcc` and golangci-lint print, as editors' problem matchers read it.
const GENERIC_LINE = /^(\S[^:]*):(\d+)(?::(\d+))?: (?:fatal )?(error|warning|note): (.*)$/
const GENERIC_RULE = /\s(?:\[([\w-]+)\]|\(([a-z][\w-]*)\))$/
const NOISE = /^(?:bun test v|Errors {2}Files$|Ran \d+ tests?|note: |\s*\d+ expect\(\) calls|\s+\d+\s+\S+:\d+$|\s*\d+ errors? and \d+ warnings? potentially fixable)/

export type Collector = (lines: string[], used: Set<number>) => ToolError[]

// Blank lines and the headers and totals the tools print around their errors.
function isNoise(line: string): boolean {
  return line.trim() === '' || [NOISE, BUN_TEST_SUMMARY, BUN_CHECK_SUMMARY, TSC_SUMMARY, ESLINT_SUMMARY, BOUNDARY, BASH_ECHO, GO_NOISE, CARGO_NOISE, KAY_SUMMARY, RUFF_NOISE, PYTEST_NOISE, PYTEST_BANNER, ...PHP_NOISE, ...E2E_NOISE].some(pattern => pattern.test(line))
}

const collectBunCheck: Collector = (lines, used) => {
  const errors: ToolError[] = []

  for (let index = 0; index < lines.length; index++) {
    if (!(lines[index] ?? '').startsWith('<error file='))
      continue

    const end = lines.findIndex((line, at) => at >= index && line === '</error>')

    if (end === -1)
      break

    const { file, line, column, code, message } = bunCheckFields(lines.slice(index, end + 1).join('\n'))

    errors.push({ tool: 'bun check', file, line: Number(line), column: Number(column), rule: code, severity: 'error', message: message.replaceAll(/\s*\n\s*/g, ' ') })

    for (let at = index; at <= end; at++)
      used.add(at)

    index = end
  }

  return errors
}

// A failed test's location is the first stack frame under its `error:` line, its file's header when there is none.
const collectBunTest: Collector = (lines, used) => {
  const errors: ToolError[] = []
  const seen = new Set<string>()

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('(fail) '))
      continue

    used.add(index)

    const test = line.slice('(fail) '.length).replace(DURATION, '')

    if (seen.has(test))
      continue

    seen.add(test)

    const start = lines.findLastIndex((text, at) => at < index && BOUNDARY.test(text)) + 1
    const block = lines.slice(start, index)
    const failure = block.findIndex(text => text.startsWith('error:'))

    for (let at = start; at < index; at++)
      used.add(at)

    const frame = block.slice(Math.max(failure, 0)).map(text => BUN_TEST_FRAME.exec(text)).find(match => match !== null)
    const header = lines.slice(0, index).findLast(text => BUN_TEST_FILE.test(text))
    const expected = block.map(text => BUN_TEST_EXPECTED.exec(text)?.[1]).find(text => text !== undefined)
    const received = block.map(text => BUN_TEST_RECEIVED.exec(text)?.[1]).find(text => text !== undefined)
    const reason = failure === -1 ? 'failed' : (block[failure] ?? '').slice('error:'.length).trim()
    const values = expected === undefined || received === undefined ? '' : ` (expected ${expected}, received ${received})`

    errors.push({
      tool: 'bun test',
      file: frame?.[1] ?? header?.replace(':', '') ?? '',
      line: Number(frame?.[2] ?? 0),
      column: Number(frame?.[3] ?? 0),
      severity: 'error',
      message: `${reason}${values}`,
      test,
    })
  }

  return errors
}

// tsc, tsgo and vue-tsc, plain or pretty: an error line, the indented lines continuing its message and, pretty, its code frame.
const collectTsc: Collector = (lines, used) => {
  const errors: ToolError[] = []
  let current: ToolError | undefined
  let pretty = false

  for (const [index, line] of lines.entries()) {
    if (used.has(index))
      continue

    const plain = TSC_PLAIN_ERROR.exec(line)
    const match = plain ?? TSC_PRETTY_ERROR.exec(line)

    if (match !== null) {
      current = { tool: 'tsc', file: match[1] ?? '', line: Number(match[2]), column: Number(match[3]), rule: match[4], severity: 'error', message: match[5] ?? '' }
      pretty = plain === null
      errors.push(current)
      used.add(index)
    }
    else if (current !== undefined && TSC_CONTINUATION.test(line) && !TSC_FRAME.test(line)) {
      current.message += ` ${line.trim()}`
      used.add(index)
    }
    else if (current !== undefined && pretty && (TSC_FRAME.test(line) || TSC_SOURCE_LINE.test(line))) {
      used.add(index)
    }
    else if (!(pretty && line.trim() === '')) {
      current = undefined
    }
  }

  return errors
}

// ESLint's stylish format: a file's path line, then its problems.
const collectEslint: Collector = (lines, used) => {
  const errors: ToolError[] = []
  let file: number | undefined

  for (const [index, line] of lines.entries()) {
    if (used.has(index))
      continue

    const match = ESLINT_PROBLEM.test(line) ? ESLINT_FIELDS.exec(line) : null

    if (match !== null && file !== undefined) {
      const text = match[4] ?? ''
      const rule = ESLINT_RULE.exec(text)

      errors.push({ tool: 'eslint', file: (lines[file] ?? '').trim(), line: Number(match[1]), column: Number(match[2]), rule: rule?.[1], severity: match[3] === 'warning' ? 'warning' : 'error', message: rule === null ? text : text.slice(0, rule.index) })
      used.add(index)
      used.add(file)
    }
    else if (!isNoise(line) && !line.includes(': ') && ESLINT_FILE.test(line.trimEnd())) {
      file = index
    }
  }

  return errors
}

// `go build`, `go vet` and `go test` compile errors, `file:line:col: message` with an optional `vet: ` prefix.
const collectGo: Collector = (lines, used) => {
  const errors: ToolError[] = []

  for (const [index, line] of lines.entries()) {
    const match = used.has(index) ? null : GO_ERROR.exec(line)

    if (match === null)
      continue

    // golangci-lint prints the same shape with its linter in parentheses at the end
    const linter = GO_LINTER.exec(match[4] ?? '')

    errors.push({ tool: 'go', file: match[1] ?? '', line: Number(match[2]), column: Number(match[3] ?? 0), ...(linter === null ? {} : { rule: linter[2] }), severity: 'error', message: linter === null ? match[4] ?? '' : linter[1] ?? '' })
    used.add(index)
  }

  return errors
}

// Where the header of the diagnostic whose arrow is at `arrow` sits: the line above, or above the indented lines its message runs on.
function headerAbove(lines: string[], arrow: number, used: Set<number>): number {
  let at = arrow - 1

  while (at > 0 && arrow - at <= MAX_CONTINUATION && !used.has(at) && CONTINUATION.test(lines[at] ?? '') && !ARROW.test(lines[at] ?? ''))
    at--

  return at
}

// A diagnostic whose header line is followed by ` --> file:line:col` and a code frame, as rustc, kay check and recent ruff print it; kay check's message may run on indented lines between the two.
const collectArrowed: Collector = (lines, used) => {
  const errors: ToolError[] = []

  for (const [index, line] of lines.entries()) {
    const arrow = used.has(index) || index === 0 ? null : ARROW.exec(line)
    const at = arrow === null ? -1 : headerAbove(lines, index, used)
    const header = at === -1 ? null : lines[at] ?? ''
    const cargo = header === null ? null : CARGO_HEADER.exec(header)
    const ruff = header === null || cargo !== null ? null : RUFF_HEADER.exec(header)

    if (arrow === null || (cargo === null && ruff === null) || used.has(at))
      continue

    const [, file = '', row, column] = arrow
    const fields = { file, line: Number(row), column: Number(column) }

    errors.push(cargo === null
      ? { tool: 'ruff', ...fields, rule: ruff?.[1], severity: 'error', message: ruff?.[2] ?? '' }
      : { tool: file.endsWith('.rs') ? 'cargo' : 'kay check', ...fields, rule: cargo[2], severity: cargo[1] === 'warning' ? 'warning' : 'error', message: cargo[3] ?? '' })

    for (let taken = at; taken <= index; taken++)
      used.add(taken)

    // The code frame and the notes under the arrow, up to the blank line ending the diagnostic.
    for (let frame = index + 1; frame < lines.length && (lines[frame] ?? '').trim() !== ''; frame++) {
      if (CARGO_HEADER.test(lines[frame] ?? '') || RUFF_HEADER.test(lines[frame] ?? ''))
        break

      used.add(frame)
    }
  }

  return errors
}

// Ruff's concise format, `file:line:col: CODE message`, which older versions also print as the header of each diagnostic.
const collectRuff: Collector = (lines, used) => {
  const errors: ToolError[] = []

  for (const [index, line] of lines.entries()) {
    const match = used.has(index) ? null : RUFF_CONCISE.exec(line)

    if (match === null)
      continue

    errors.push({ tool: 'ruff', file: match[1] ?? '', line: Number(match[2]), column: Number(match[3]), rule: match[4], severity: 'error', message: match[5] ?? '' })
    used.add(index)
  }

  return errors
}

// pytest's failures section: each `file:line: Exception` location, the message from the `E` lines above it, the section and its short summary otherwise accounted for.
const collectPytest: Collector = (lines, used) => {
  const errors: ToolError[] = []
  const title = (line: string | undefined) => PYTEST_BANNER.exec(line ?? '')?.[1]
  const start = lines.findIndex(line => PYTEST_FAILURES.has(title(line) ?? ''))

  if (start === -1)
    return errors

  const end = lines.findIndex((line, index) => index > start && title(line) !== undefined && !PYTEST_FAILURES.has(title(line) ?? ''))
  const stop = end === -1 ? lines.length : end
  let message: string[] = []
  let frame: { file: string, line: number } | undefined

  for (let index = start; index < stop; index++) {
    const line = lines[index] ?? ''
    const failure = PYTEST_E_LINE.exec(line)

    if (failure !== null) {
      message.push((failure[1] ?? '').trim())
    }
    else {
      // A frame (`file:line: in func`, from --tb=short or a collection error) takes the message of the `E` lines under it.
      if (frame !== undefined && message.length > 0) {
        errors.push({ tool: 'pytest', ...frame, column: 0, severity: 'error', message: message[0] ?? '' })
        frame = undefined
      }

      const location = PYTEST_LOCATION.exec(line)

      if (location !== null && PYTEST_FRAME.test(location[3] ?? '')) {
        frame = { file: location[1] ?? '', line: Number(location[2]) }
      }
      else if (location !== null) {
        const [exception = ''] = (location[3] ?? '').split(PYTEST_EXCEPTION_END)
        const first = message[0] ?? ''
        const text = first === '' || first.startsWith(exception) ? first || (location[3] ?? '') : `${location[3] ?? ''}: ${first}`

        errors.push({ tool: 'pytest', file: location[1] ?? '', line: Number(location[2]), column: 0, severity: 'error', message: text })
      }

      if (PYTEST_SECTION.test(line))
        frame = undefined

      if (line.trim() !== '')
        message = []
    }

    used.add(index)
  }

  if (frame !== undefined && message.length > 0)
    errors.push({ tool: 'pytest', ...frame, column: 0, severity: 'error', message: message[0] ?? '' })

  for (let index = stop; index < lines.length; index++) {
    if (PYTEST_SUMMARY_LINE.test(lines[index] ?? ''))
      used.add(index)
  }

  return errors
}

// Any line of the `file:line[:col]: severity: message` shape no format above took. Notes only add context to the error before them, so they are counted as read and not listed.
const collectGeneric: Collector = (lines, used) => {
  const errors: ToolError[] = []

  for (const [index, line] of lines.entries()) {
    const match = used.has(index) ? null : GENERIC_LINE.exec(line)

    if (match === null)
      continue

    used.add(index)

    if (match[4] === 'note')
      continue

    const text = match[5] ?? ''
    const ruled = GENERIC_RULE.exec(text)
    const rule = ruled?.[1] ?? ruled?.[2]

    errors.push({ tool: 'generic', file: match[1] ?? '', line: Number(match[2]), column: Number(match[3] ?? 0), rule, severity: match[4] === 'warning' ? 'warning' : 'error', message: ruled === null ? text : text.slice(0, ruled.index).trimEnd() })
  }

  return errors
}

const COLLECTORS: Collector[] = [collectBunCheck, collectBunTest, collectVitest, collectPlaywright, collectPhpunit, collectPhpstan, collectCsFixer, collectPytest, collectArrowed, collectRuff, collectGo, collectTsc, collectEslint, collectGeneric]

// Every error the known formats report, each format's in its own order, and how many non-blank lines none of them accounted for.
export function parseErrors(output: string): ParsedErrors {
  const lines = stripAnsi(output).split('\n')

  if (BASH_ECHO.test(lines[0] ?? ''))
    lines.shift()

  const used = new Set<number>()
  const seen = new Set<string>()
  const errors = COLLECTORS.flatMap(collect => collect(lines, used)).filter((error) => {
    const key = [error.file, error.line, error.column, error.message, error.test].join('\0')

    if (seen.has(key))
      return false

    seen.add(key)

    return true
  })
  const unrecognised = lines.filter((line, index) => !used.has(index) && !isNoise(line)).length

  return { errors, unrecognised }
}
