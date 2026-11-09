import { stripAnsi } from './text'

const BASH_ECHO = /^\$ /
const DURATION = / \[[\d.]+m?s\]$/
const BOUNDARY = /^(?:\((?:pass|fail|skip|todo)\) |\S+\.test\.[jt]sx?:$)/
const BUN_TEST_SUMMARY = /^\s*\d+ (?:pass|fail|skip|todo)$|^Ran \d+ tests?/
const BUN_CHECK_BLOCK = /<error file=[\s\S]*?<\/error>/g
const BUN_CHECK_SOURCE = /<source>[\s\S]*?<\/source>\n?/g
const BUN_CHECK_ATTRIBUTE = /(\w+)="([^"]*)"/g
const BUN_CHECK_SUMMARY = /^Found \d+ errors?/
const TSC_ERROR = /\berror TS\d+/
const TSC_CONTINUATION = /^\s{2,}\S/
const TSC_FRAME = /^\s*[~^|]/
const TSC_SUMMARY = /^Found \d+ errors?/
const ESLINT_PROBLEM = /^\s+\d+:\d+\s+(?:error|warning)\s/
const ESLINT_SUMMARY = /^(?:✖ )?\d+ problems? \(/
const PHPSTAN_TABLE = /^\s*-{3,} -{3,}/
const PHPSTAN_NOISE = /^\s*\[OK\]/
const PHP_FAILURES = /^(?:There w(?:as|ere) \d+ (?:failure|error|risky|warning)|\s+(?:FAIL|FAILED)\s+\S|In \S+\.php line \d+:$)/
const VITEST_FAIL_LINE = /^ FAIL {2}\S/
const PLAYWRIGHT_FAIL_LINE = /^ {2}1\) .+:\d+:\d+ › .+ ─+$/
const CS_FIXER_LINE = /^\s+\d+\) \S.*\.php(?: \(.+\))?$/
const CS_FIXER_TOTAL = /^Found \d+ of \d+ files/
const MAX_TESTS = 10
const MAX_LINES = 100
const TAIL = 30

type Parser = (lines: string[]) => string[] | undefined

// Each failed bun test's own output, from the line after the previous boundary down to its `(fail)` line, once per test as bun test lists them again by name at the end.
const bunTest: Parser = (lines) => {
  const seen = new Set<string>()
  const blocks: string[] = []

  for (const [index, line] of lines.entries()) {
    const name = line.replace(DURATION, '')

    if (!line.startsWith('(fail) ') || seen.has(name))
      continue

    seen.add(name)

    if (blocks.length < MAX_TESTS)
      blocks.push(lines.slice(lines.findLastIndex((text, at) => at < index && BOUNDARY.test(text)) + 1, index + 1).join('\n').trim())
  }

  if (blocks.length === 0)
    return undefined

  if (seen.size > MAX_TESTS)
    blocks.push(`and ${seen.size - MAX_TESTS} more failed tests`)

  return [...blocks.join('\n\n').split('\n'), '', ...lines.filter(line => BUN_TEST_SUMMARY.test(line)).map(line => line.trim())]
}

// Bun's type checker prints <error file= line= column= code=> blocks with a source frame, which go down to one `file:line:column CODE: message` line each.
const bunCheck: Parser = (lines) => {
  const text = lines.join('\n')
  const blocks = text.match(BUN_CHECK_BLOCK)

  if (blocks === null)
    return undefined

  const errors = blocks.map((block) => {
    const { file, line, column, code, message } = bunCheckFields(block)

    return `${file}:${line}:${column} ${code}: ${message}`
  })

  return [...errors, ...lines.filter(line => BUN_CHECK_SUMMARY.test(line))]
}

export function bunCheckFields(block: string): { file: string, line: string, column: string, code: string, message: string } {
  const attributes = Object.fromEntries([...block.slice(0, block.indexOf('\n')).matchAll(BUN_CHECK_ATTRIBUTE)].map(match => [match[1] ?? '', match[2] ?? '']))

  return {
    file: attributes.file ?? '',
    line: attributes.line ?? '',
    column: attributes.column ?? '',
    code: attributes.code ?? '',
    message: block.replace(BUN_CHECK_SOURCE, '').split('\n').slice(1, -1).join('\n').trim(),
  }
}

// tsc, tsgo and vue-tsc, plain (`file(1,2): error TS1`) or pretty (`file:1:2 - error TS1`), with the indented lines continuing a message and without the pretty code frames.
const tsc: Parser = (lines) => {
  const kept: string[] = []
  let inError = false

  for (const line of lines) {
    if (TSC_ERROR.test(line)) {
      inError = true
      kept.push(line)
    }
    else if (TSC_SUMMARY.test(line)) {
      inError = false
      kept.push(line)
    }
    else if (inError && TSC_CONTINUATION.test(line) && !TSC_FRAME.test(line)) {
      kept.push(line)
    }
    else {
      inError = false
    }
  }

  return kept.some(line => TSC_ERROR.test(line)) ? kept : undefined
}

// ESLint's stylish format as eslint and keslint print it: each file's path with its problem lines, then the totals.
const eslint: Parser = (lines) => {
  const kept: string[] = []
  let file = ''
  let shown = ''

  for (const line of lines) {
    if (ESLINT_PROBLEM.test(line)) {
      if (file !== shown) {
        kept.push(file)
        shown = file
      }

      kept.push(line)
    }
    else if (ESLINT_SUMMARY.test(line)) {
      kept.push(line)
    }
    else if (line.trim() !== '') {
      file = line
    }
  }

  return kept.some(line => ESLINT_PROBLEM.test(line)) ? kept : undefined
}

// PHPStan's table format, from the first table's rule line to the end.
const phpstan: Parser = (lines) => {
  const start = lines.findIndex(line => PHPSTAN_TABLE.test(line))

  return start === -1 ? undefined : lines.slice(start).filter(line => !PHPSTAN_NOISE.test(line))
}

// PHPUnit's and ParaTest's failure listing, Pest's FAIL blocks and a Symfony console exception (how ParaTest reports a crashed worker), to the end of the output.
const php: Parser = (lines) => {
  const start = lines.findIndex(line => PHP_FAILURES.test(line))

  return start === -1 ? undefined : lines.slice(start)
}

// Vitest's failure blocks, from the first ` FAIL ` line to the end.
const vitest: Parser = (lines) => {
  const start = lines.findIndex(line => VITEST_FAIL_LINE.test(line))

  return start === -1 ? undefined : lines.slice(start)
}

// Playwright's numbered failures, from the first one to the end.
const playwright: Parser = (lines) => {
  const start = lines.findIndex(line => PLAYWRIGHT_FAIL_LINE.test(line))

  return start === -1 ? undefined : lines.slice(start)
}

// PHP CS Fixer's dry-run listing, one line per file with its fixers, without the diffs.
const phpCsFixer: Parser = (lines) => {
  const files = lines.filter(line => CS_FIXER_LINE.test(line) || CS_FIXER_TOTAL.test(line))

  return files.some(line => CS_FIXER_LINE.test(line)) ? files : undefined
}

const PARSERS: Parser[] = [bunTest, bunCheck, tsc, eslint, vitest, playwright, phpCsFixer, phpstan, php]
// Without bun test and PHPUnit, which the CI callers read their own way.
const TOOL_PARSERS: Parser[] = [bunCheck, tsc, eslint, vitest, playwright, phpCsFixer, phpstan]

function squeeze(lines: string[]): string[] {
  const out: string[] = []

  for (const line of lines.map(text => text.trimEnd())) {
    if (line !== '' || out.at(-1) !== '')
      out.push(line)
  }

  while (out.at(-1) === '')
    out.pop()

  return out
}

function cut(shown: string[]): string {
  return shown.length > MAX_LINES ? [...shown.slice(0, MAX_LINES), `... ${shown.length - MAX_LINES} more lines`].join('\n') : shown.join('\n')
}

function recognised(lines: string[], parsers: Parser[]): string[] | undefined {
  return parsers.map(parser => parser(lines)).find(result => result !== undefined && result.some(line => line.trim() !== ''))
}

// What a failed step's output says went wrong, in the first format that recognises it, else its last lines.
export function failureExcerpt(output: string): string {
  const lines = stripAnsi(output).split('\n')

  // `bun run` echoes the script's command first.
  if (BASH_ECHO.test(lines[0] ?? ''))
    lines.shift()

  return cut(squeeze(recognised(lines, PARSERS) ?? lines.slice(-TAIL)))
}

// The same for the lines of a CI log, for the callers that keep their own handling of bun test output and of what no tool format recognises: undefined unless tsc, eslint, vitest, playwright, phpstan, php-cs-fixer or bun check output is found.
export function toolExcerpt(lines: string[]): string | undefined {
  const found = recognised(lines.map(line => stripAnsi(line)), TOOL_PARSERS)

  return found === undefined ? undefined : cut(squeeze(found))
}

// The patterns the log parsers of this module share with the callers that read the same output as error lines.
export const LOG_PATTERNS = { BASH_ECHO, DURATION, BOUNDARY, BUN_TEST_SUMMARY, BUN_CHECK_SUMMARY, TSC_CONTINUATION, TSC_FRAME, TSC_SUMMARY, ESLINT_PROBLEM, ESLINT_SUMMARY }
