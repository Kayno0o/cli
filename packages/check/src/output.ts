const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[\\d;?]*[a-z]`, 'gi')
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
const PHP_FAILURES = /^(?:There w(?:as|ere) \d+ (?:failure|error|risky|warning)|\s+(?:FAIL|FAILED)\s+\S)/
const MAX_TESTS = 10
const MAX_LINES = 100
const TAIL = 30

export type Parser = (lines: string[]) => string[] | undefined

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

// Each failed bun test's own output, from the line after the previous boundary down to its `(fail)` line, once per test as bun test lists them again by name at the end.
export const bunTest: Parser = (lines) => {
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
export const bunCheck: Parser = (lines) => {
  const text = lines.join('\n')
  const blocks = text.match(BUN_CHECK_BLOCK)

  if (blocks === null)
    return undefined

  const errors = blocks.map((block) => {
    const attributes = Object.fromEntries([...block.matchAll(BUN_CHECK_ATTRIBUTE)].map(match => [match[1] ?? '', match[2] ?? '']))
    const message = block.replace(BUN_CHECK_SOURCE, '').split('\n').slice(1, -1).join('\n').trim()

    return `${attributes.file}:${attributes.line}:${attributes.column} ${attributes.code}: ${message}`
  })

  return [...errors, ...lines.filter(line => BUN_CHECK_SUMMARY.test(line))]
}

// tsc, tsgo and vue-tsc, plain (`file(1,2): error TS1`) or pretty (`file:1:2 - error TS1`), with the indented lines continuing a message and without the pretty code frames.
export const tsc: Parser = (lines) => {
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
export const eslint: Parser = (lines) => {
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
export const phpstan: Parser = (lines) => {
  const start = lines.findIndex(line => PHPSTAN_TABLE.test(line))

  return start === -1 ? undefined : lines.slice(start).filter(line => !PHPSTAN_NOISE.test(line))
}

// PHPUnit's failure listing and Pest's FAIL blocks, to the end of the output.
export const php: Parser = (lines) => {
  const start = lines.findIndex(line => PHP_FAILURES.test(line))

  return start === -1 ? undefined : lines.slice(start)
}

const PARSERS: Parser[] = [bunTest, bunCheck, tsc, eslint, phpstan, php]

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

// What a failed step's output says went wrong, in the first format that recognises it, else its last lines.
export function failureExcerpt(output: string): string {
  const lines = stripAnsi(output).split('\n')

  // `bun run` echoes the script's command first.
  if (BASH_ECHO.test(lines[0] ?? ''))
    lines.shift()

  const parsed = PARSERS.map(parser => parser(lines)).find(result => result !== undefined && result.some(line => line.trim() !== ''))
  const shown = squeeze(parsed ?? lines.slice(-TAIL))

  return shown.length > MAX_LINES ? [...shown.slice(0, MAX_LINES), `... ${shown.length - MAX_LINES} more lines`].join('\n') : shown.join('\n')
}
