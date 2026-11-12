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
// What opens a body of members: a class and its kin across languages; the words JS lets be names (record, object...) only before a capitalised name.
const HOLDS_MEMBERS = /\b(?:(?:class|interface|trait|struct|enum)\s|impl[\s<]|(?:record|extension|protocol|object)\s+[A-Z]|companion\s+object\b)/
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
// A class property or object key holding an arrow function or a function: `prop = () =>`, `prop: Handler = async x =>`, `key: function`, `prop = <T,>(a: T) =>`, or `prop = (` whose parameters go on over the next lines.
const PROPERTY_FUNCTION = /^[#\w$]+\s*(?:[?!]?:[^=]*)?[:=]\s*(?:async\s+)?(?:function\b|(?:<[^>]*>\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>|(?:<[^>]*>\s*)?\($)/
// What comes before a brace opening an object literal rather than a block, or the body of an anonymous class (`new Thread() {`).
const OBJECT_POSITION = /(?:[=(,[:?]|\|\||&&|\breturn|\bdefault)\s*$|\bnew\s+[\w$.]+(?:<[^>]*>)?\s*\([^()]*\)\s*$/
// A switch label, whose colon opens a block, not an object.
const CASE_LABEL = /(?:^|[\s;{])(?:case\b.*|default\s*):\s*$/
// What a slash follows when it opens a regex literal rather than divides.
const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};]|\b(?:return|typeof|case|throw|yield|await|in|of))\s*$/
// A Rust char literal, so the quote of a lifetime (`'a`) opens nothing.
const RUST_CHAR = /^'(?:\\(?:u\{[\da-f]{1,6}\}|x[\da-f]{2}|.)|[^'\\])'/i
const RUST = /\.rs$/i
const LONGEST_DEFINITION = 400
const LONGEST_SIGNATURE = 160

function indentOf(line: string): number {
  return INDENT.exec(line)?.[0].length ?? 0
}

function escaped(name: string): string {
  return name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

// Whether the line declares the name: a declaration keyword before it, or, inside a class body or an object literal, a member whose parameters follow it or a property holding a function.
export function declares(line: string, name: string, inMembers = true): boolean {
  const text = line.trim()
  const word = new RegExp(String.raw`^${escaped(name)}\b`)

  if (DECLARATION.test(text)) {
    const rest = text.replace(DECLARATION, '').replace(RECEIVER, '')

    return word.test(rest.replace(STAR, ''))
  }

  if (!inMembers || line === text || CALL_KEYWORDS.test(text))
    return false

  const named = text.replace(MODIFIERS, '')

  return word.test(named) && ((MEMBER.test(text) && (text.endsWith('{') || text.endsWith(':'))) || PROPERTY_FUNCTION.test(named))
}

// The index of the slash closing the regex literal opened at `start`, -1 when the line holds none, the slash being a division.
function regexEnd(line: string, start: number): number {
  let inClass = false

  for (let i = start + 1; i < line.length; i++) {
    const char = line[i]

    if (char === '\\')
      i++
    else if (char === '[')
      inClass = true
    else if (char === ']')
      inClass = false
    else if (char === '/' && !inClass)
      return i
  }

  return -1
}

interface Quote { open: string, depth: number }

// Calls `each` with every character of the line outside strings, regex literals and comments, with its index; `quote.open` carries a template literal or a block comment (`/*`) over to the next line, and `quote.depth` how deep Rust's nested block comments go.
function codeChars(line: string, quote: Quote, rust: boolean, each: (char: string, index: number) => void): void {
  for (let i = 0; i < line.length; i++) {
    const char = line[i] ?? ''

    if (quote.open === '/*') {
      if (rust && char === '/' && line[i + 1] === '*') {
        quote.depth++
        i++
      }
      else if (char === '*' && line[i + 1] === '/') {
        quote.depth--
        quote.open = quote.depth === 0 ? '' : '/*'
        i++
      }

      continue
    }

    if (quote.open !== '') {
      if (char === '\\')
        i++
      else if (char === quote.open)
        quote.open = ''

      continue
    }

    if (char === '/' && line[i + 1] === '/')
      break

    if (char === '/' && line[i + 1] === '*') {
      quote.open = '/*'
      quote.depth = 1
      i++

      continue
    }

    const regex = char === '/' && !rust && REGEX_BEFORE.test(line.slice(0, i)) ? regexEnd(line, i) : -1

    if (regex !== -1)
      i = regex
    else if (rust && char === '\'')
      i += (RUST_CHAR.exec(line.slice(i))?.[0].length ?? 1) - 1
    else if (char === '"' || char === '\'' || char === '`')
      quote.open = char
    else
      each(char, i)
  }

  // a line ends a single-quoted string, never a template literal or a block comment
  if (quote.open !== '`' && quote.open !== '/*')
    quote.open = ''
}

// The counts a line changes, strings and line comments skipped.
function depthChange(line: string, quote: Quote, rust: boolean): { braces: number, parens: number } {
  let braces = 0
  let parens = 0

  codeChars(line, quote, rust, (char) => {
    if (char === '{')
      braces++
    else if (char === '}')
      braces--
    else if (char === '(' || char === '[')
      parens++
    else if (char === ')' || char === ']')
      parens--
  })

  return { braces, parens }
}

// For each line, whether it sits in a class body or an object literal, where members are declared, rather than among statements; every line of a file without braces (Python, YAML), or whose braces the scan loses count of, may hold members.
function memberLines(lines: readonly string[], path: string): boolean[] {
  const everywhere = lines.map(() => true)

  if (INDENTED.test(path))
    return everywhere

  const quote = { open: '', depth: 0 }
  const rust = RUST.test(path)
  const open: boolean[] = []
  let previous = ''
  let lost = false

  const members = lines.map((line) => {
    const inMembers = open.at(-1) === true

    codeChars(line, quote, rust, (char, index) => {
      if (char === '}') {
        lost ||= open.pop() === undefined

        return
      }

      if (char !== '{')
        return

      // A brace alone on its line opens what the line above declared.
      const before = (line.slice(0, index).trim() === '' ? previous : line.slice(0, index)).trimEnd()

      open.push(HOLDS_MEMBERS.test(before) || (OBJECT_POSITION.test(before) && !CASE_LABEL.test(before)))
    })

    if (line.trim() !== '')
      previous = line

    return inMembers
  })

  return lost || open.length > 0 || quote.open !== '' ? everywhere : members
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

  const quote = { open: '', depth: 0 }
  const rust = RUST.test(path)
  let braces = 0
  let parens = 0
  let opened = false

  for (let i = start; i <= last; i++) {
    const line = lines[i] ?? ''
    const change = depthChange(line, quote, rust)

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
  const members = memberLines(lines, path)
  const spans: Span[] = []

  for (let i = 0; i < lines.length; i++) {
    if (!declares(lines[i] ?? '', name, members[i]))
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
