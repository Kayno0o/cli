export interface Span {
  path: string
  // 1-based and inclusive.
  from: number
  to: number
}

// A location opening a line of tool output: `path:line`, `path:line:col` or tsc's `path(line,col)`, as errs, grep -n, rg -n and linters print them.
const LOCATION = /^(?:\.\/)?([^\s:()]+)(?::(\d+)(?::\d+)?|\((\d+),\d+\))(?=[:\s)]|$)/
// The keywords a declaration opens with, in TS, JS, Python, Go, Rust, PHP, Java and Kotlin.
const DECLARATION = /^(?:(?:export|default|declare|abstract|async|pub(?:\([^)]*\))?|public|private|protected|internal|final|open|sealed|static|suspend)\s+)*(?:function\*?|class|interface|type|enum|const|let|var|namespace|module|def|func|fun|fn|struct|trait|impl)\s/
// A member of a class or an object: modifiers, the name, maybe type parameters, then its parameters.
const MODIFIER_WORDS = String.raw`(?:public|private|protected|internal|final|open|sealed|static|async|suspend|override|readonly|abstract|get|set|pub(?:\([^)]*\))?|function|fn|def|func|fun)\s+`
// A return type, as Java and C# put one between the modifiers and the name; only after a modifier, so `return x(` and `else y(` are no member.
const RETURN_TYPE = String.raw`(?:[\w$.]+(?:<[^>]*>)?(?:\[\])*\??\s+(?=[#\w$]+\s*(?:<[^>]*>\s*)?\())?`
const MODIFIERS = new RegExp(String.raw`^(?:(?:${MODIFIER_WORDS})+${RETURN_TYPE})?`)
const MEMBER = new RegExp(String.raw`^(?:(?:${MODIFIER_WORDS})+${RETURN_TYPE})?[#\w$]+\s*(?:<[^>]*>\s*)?\(`)
// A Go method's receiver, `func (r *T) name`, and a generator's star.
const RECEIVER = /^(?:\([^)]*\)\s*)?/
const STAR = /^\*?\s*/
const HOLDS_MEMBERS = /\b(?:class|interface|trait|impl|struct)\s/
const CALL_KEYWORDS = /^(?:if|for|while|switch|catch|return|await|throw|new|else|do|try|super|typeof)\b/
const LEADING = /^(?:\/\/|\/\*|\*|#(?!!)|@)/
// A binding the module keeps to itself, left out of an outline.
const LOCAL_BINDING = /^(?:const|let|var)\s/
const HEADING = /^#{1,6}\s/
const TRAILING_NEWLINE = /\n$/
const MARKDOWN = /\.(?:md|mdx|markdown)$/i
const INDENTED = /\.(?:py|yml|yaml)$/i
const INDENT = /^\s*/
const CONTINUES = /(?:[=(,[{:?|&+\-*/<>]|=>)$/
const BODY_OPENER = /\s*\{\s*$/
const LONGEST_DEFINITION = 400
const LONGEST_SIGNATURE = 160

function indentOf(line: string): number {
  return INDENT.exec(line)?.[0].length ?? 0
}

function escaped(name: string): string {
  return name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

// Whether the line declares the name: a declaration keyword before it, or a member whose parameters follow it.
export function declares(line: string, name: string): boolean {
  const text = line.trim()
  const word = new RegExp(String.raw`^${escaped(name)}\b`)

  if (DECLARATION.test(text)) {
    const rest = text.replace(DECLARATION, '').replace(RECEIVER, '')

    return word.test(rest.replace(STAR, ''))
  }

  return line !== text && MEMBER.test(text) && !CALL_KEYWORDS.test(text) && word.test(text.replace(MODIFIERS, '')) && (text.endsWith('{') || text.endsWith(':'))
}

// The counts a line changes, strings and line comments skipped.
function depthChange(line: string, quote: { open: string }): { braces: number, parens: number } {
  let braces = 0
  let parens = 0

  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? ''

    if (quote.open !== '') {
      if (char === '\\')
        i++
      else if (char === quote.open)
        quote.open = ''

      continue
    }

    if (char === '/' && line[i + 1] === '/')
      break

    if (char === '"' || char === '\'' || char === '`')
      quote.open = char
    else if (char === '{')
      braces++
    else if (char === '}')
      braces--
    else if (char === '(' || char === '[')
      parens++
    else if (char === ')' || char === ']')
      parens--
  }

  // a line ends a single-quoted string, never a template literal
  if (quote.open !== '`')
    quote.open = ''

  return { braces, parens }
}

// The last line of the declaration starting at `start` (0-based): its braces closed, the line its indentation ends for Python or YAML.
function endOf(lines: readonly string[], start: number, path: string): number {
  const last = Math.min(lines.length - 1, start + LONGEST_DEFINITION - 1)

  if (INDENTED.test(path)) {
    const indent = indentOf(lines[start] ?? '')
    let end = start

    for (let i = start + 1; i <= last; i++) {
      const line = lines[i] ?? ''

      if (line.trim() !== '' && indentOf(line) <= indent)
        break

      if (line.trim() !== '')
        end = i
    }

    return end
  }

  const quote = { open: '' }
  let braces = 0
  let parens = 0
  let opened = false

  for (let i = start; i <= last; i++) {
    const line = lines[i] ?? ''
    const change = depthChange(line, quote)

    opened ||= change.braces > 0 || line.includes('{')
    braces += change.braces
    parens += change.parens

    if (braces <= 0 && parens <= 0 && quote.open === '' && (opened || !CONTINUES.test(line.trimEnd())))
      return i
  }

  return last
}

// The comment and decorator lines right above the line, which belong to the declaration.
function leadingStart(lines: readonly string[], start: number): number {
  let first = start

  while (first > 0 && LEADING.test((lines[first - 1] ?? '').trim()))
    first--

  return first
}

// Each declaration of the name in the text, with its comments, as spans.
export function definitions(text: string, path: string, name: string): Span[] {
  const lines = text.split('\n')
  const spans: Span[] = []

  for (let i = 0; i < lines.length; i++) {
    if (!declares(lines[i] ?? '', name))
      continue

    const end = endOf(lines, i, path)

    spans.push({ path, from: leadingStart(lines, i) + 1, to: end + 1 })
    i = end
  }

  return spans
}

// The lines naming the symbol as a whole word, 1-based.
export function usages(text: string, name: string): number[] {
  const word = new RegExp(String.raw`(?<![\w$])${escaped(name)}(?![\w$])`)

  return text.split('\n').flatMap((line, i) => word.test(line) ? [i + 1] : [])
}

export interface OutlineEntry {
  line: number
  depth: number
  text: string
}

function signature(line: string): string {
  const text = line.trim().replace(BODY_OPENER, '')

  return text.length > LONGEST_SIGNATURE ? `${text.slice(0, LONGEST_SIGNATURE - 1)}…` : text
}

// The declarations at the top of the file and the members one level inside its classes and interfaces; a Markdown file's headings.
export function outline(text: string, path: string): OutlineEntry[] {
  const lines = text.split('\n')

  if (MARKDOWN.test(path))
    return lines.flatMap((line, i) => HEADING.test(line) ? [{ line: i + 1, depth: (line.indexOf(' ') - 1), text: line.trim() }] : [])

  const entries: OutlineEntry[] = []
  let memberIndent: number | undefined

  for (const [i, line] of lines.entries()) {
    const text = line.trim()
    const indent = indentOf(line)

    if (indent === 0 && DECLARATION.test(text) && !LOCAL_BINDING.test(text)) {
      entries.push({ line: i + 1, depth: 0, text: signature(line) })
      memberIndent = HOLDS_MEMBERS.test(text) ? -1 : undefined
    }
    else if (indent === 0 && text !== '' && !text.startsWith('{') && !text.startsWith('}') && !LEADING.test(text)) {
      memberIndent = undefined
    }
    else if (memberIndent !== undefined && indent > 0 && (memberIndent === -1 || indent === memberIndent) && MEMBER.test(text) && !CALL_KEYWORDS.test(text)) {
      memberIndent = indent
      entries.push({ line: i + 1, depth: 1, text: signature(line) })
    }
  }

  return entries
}

// The spans around each line matching, `context` lines on each side, overlapping ones merged.
export function around(text: string, path: string, pattern: RegExp, context: number): Span[] {
  const lines = text.replace(TRAILING_NEWLINE, '').split('\n')

  return spansAround(path, lines.length, lines.flatMap((line, i) => pattern.test(line) ? [i + 1] : []), context)
}

// The spans around the lines numbered, `context` lines on each side within the file's `count` lines, overlapping ones merged; a line past the end is left out.
export function spansAround(path: string, count: number, numbers: readonly number[], context: number): Span[] {
  const spans: Span[] = []

  for (const number of [...new Set(numbers)].filter(each => each >= 1 && each <= count).sort((a, b) => a - b)) {
    const from = Math.max(1, number - context)
    const to = Math.min(count, number + context)
    const previous = spans.at(-1)

    if (previous !== undefined && from <= previous.to + 1)
      previous.to = to
    else
      spans.push({ path, from, to })
  }

  return spans
}

// The line numbers each path is named with in the text, the paths in the order they first appear.
export function locations(text: string): Map<string, number[]> {
  const found = new Map<string, number[]>()

  for (const line of Bun.stripANSI(text).split('\n')) {
    const match = LOCATION.exec(line.trim())

    if (match?.[1] !== undefined)
      found.set(match[1], [...found.get(match[1]) ?? [], Number(match[2] ?? match[3])])
  }

  return found
}
