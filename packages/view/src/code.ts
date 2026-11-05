import type { Theme } from './theme'

interface Language {
  // What starts a comment that runs to the end of the line.
  line: string[]
  block?: [open: string, close: string]
  quotes: string
  keywords: Set<string>
  // A name at the start of a line followed by the match, drawn as a key: a yaml mapping, a toml or ini setting.
  key?: RegExp
  // Whether the first word of a command, and a flag, are drawn as such: a shell.
  commands?: boolean
  // Whether a quoted string followed by a colon is a key.
  quotedKeys?: boolean
  // A whole line drawn as a heading, such as an ini or toml section.
  section?: RegExp
}

const WORD_START = /[a-z_$]/i
const WORD = /^[\w$-]+/
const NUMBER = /^(?:0x[\da-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)/i
const PREVIOUS_WORD = /[\w$]$/
const AFTER_KEY = /^\s*:/
const YAML_KEY = /^(\s*(?:- )?)([\w.\-/]+)(?=:(?:\s|$))/
const SETTING_KEY = /^(\s*)([\w.-]+)(?=\s*[=:])/
const SECTION = /^\s*\[.*\]\s*$/
const WHITESPACE = /\s/
const FLAG = /^--?[a-z][\w-]*/i
const COMMAND_END = /[|&;(]\s*$/
const PROMPT = /^\s*(?:[$>]\s*)?$/
const DIGIT = /\d/
const TRAILING_NEWLINE = /\n$/
const LEADING_DOT = /^\./
const TRIPLE_QUOTES = ['"""', '\'\'\'']

function words(list: string): Set<string> {
  return new Set(list.split(' '))
}

const SLASHES: Pick<Language, 'line' | 'block'> = { line: ['//'], block: ['/*', '*/'] }
const HASH: Pick<Language, 'line'> = { line: ['#'] }
const CONSTANTS = 'true false null undefined NaN Infinity'

const C_LIKE = 'if else for while do switch case default break continue return throw try catch finally new delete typeof instanceof in of void yield await async static public private protected readonly abstract extends implements super this'
const SCRIPT = `${C_LIKE} const let var function class import export from as type interface enum namespace declare satisfies keyof is get set ${CONSTANTS}`

const LANGUAGES = {
  script: { ...SLASHES, quotes: '"\'`', keywords: words(SCRIPT) },
  json: { line: [], quotes: '"', keywords: words('true false null'), quotedKeys: true },
  jsonc: { ...SLASHES, quotes: '"', keywords: words('true false null'), quotedKeys: true },
  python: { ...HASH, quotes: '"\'', keywords: words('def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield async await global nonlocal del assert None True False self') },
  shell: { ...HASH, commands: true, quotes: '"\'`', keywords: words('if then else elif fi for while until do done case esac in function return exit local export set unset source alias echo cd end switch begin and or not') },
  yaml: { ...HASH, quotes: '"\'', keywords: words('true false null yes no'), key: YAML_KEY, quotedKeys: true },
  toml: { ...HASH, quotes: '"\'', keywords: words('true false'), key: SETTING_KEY, section: SECTION },
  ini: { line: ['#', ';'], quotes: '"\'', keywords: words('true false yes no on off'), key: SETTING_KEY, section: SECTION },
  css: { line: [], block: ['/*', '*/'], quotes: '"\'', keywords: words('important inherit initial unset auto none') },
  html: { line: [], block: ['<!--', '-->'], quotes: '"\'', keywords: words('') },
  sql: { line: ['--'], block: ['/*', '*/'], quotes: '"\'`', keywords: words('select from where and or not insert into values update set delete create alter drop table index view join left right inner outer full on group by order having limit offset as distinct union all null is in like between case when then else end primary key foreign references default unique with returning true false') },
  rust: { ...SLASHES, quotes: '"', keywords: words('fn let mut const static struct enum impl trait pub use mod crate self super if else match for while loop break continue return as in ref move async await dyn where type unsafe true false None Some Ok Err') },
  go: { ...SLASHES, quotes: '"\'`', keywords: words('func var const type struct interface map chan package import if else for range switch case default break continue return go defer select fallthrough goto nil true false') },
  php: { ...SLASHES, line: ['//', '#'], quotes: '"\'', keywords: words(`${C_LIKE} function class interface trait namespace use public private protected static final echo array fn match list isset empty require include require_once include_once true false null`) },
  java: { ...SLASHES, quotes: '"\'', keywords: words(`${C_LIKE} class interface enum package import final void int long double float boolean char byte short true false null var record`) },
  c: { ...SLASHES, quotes: '"\'', keywords: words(`${C_LIKE} struct union typedef enum const volatile extern sizeof void int long double float char short unsigned signed auto register inline static include define ifdef ifndef endif pragma true false NULL nullptr class template typename namespace using bool`) },
  ruby: { ...HASH, quotes: '"\'', keywords: words('def end class module if elsif else unless while until for in do begin rescue ensure return yield self nil true false and or not require require_relative include extend attr_accessor attr_reader puts then case when') },
  lua: { line: ['--'], quotes: '"\'', keywords: words('function end if then else elseif for while do repeat until return local break in and or not nil true false') },
  dockerfile: { ...HASH, quotes: '"\'', keywords: words('FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS') },
  makefile: { ...HASH, quotes: '"\'', keywords: words('ifeq ifneq ifdef ifndef else endif include define endef export') },
} satisfies Record<string, Language>

export type Name = keyof typeof LANGUAGES

// The extensions, file names and code block names each language goes by.
const ALIASES: Record<Name, string[]> = {
  script: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'typescript', 'javascript', 'vue', 'svelte'],
  json: ['json', 'jsonl', 'ndjson'],
  jsonc: ['jsonc', 'json5'],
  python: ['py', 'python'],
  shell: ['sh', 'bash', 'zsh', 'fish', 'shell', 'console'],
  yaml: ['yml', 'yaml'],
  toml: ['toml'],
  ini: ['ini', 'conf', 'cfg', 'properties', 'editorconfig'],
  css: ['css', 'scss', 'less'],
  html: ['html', 'htm', 'xml', 'svg'],
  sql: ['sql'],
  rust: ['rs', 'rust'],
  go: ['go', 'golang'],
  php: ['php'],
  java: ['java', 'kt', 'kts', 'cs', 'swift', 'dart', 'scala'],
  c: ['c', 'h', 'cpp', 'cc', 'hpp', 'cxx'],
  ruby: ['rb', 'ruby'],
  lua: ['lua'],
  dockerfile: ['dockerfile', 'containerfile'],
  makefile: ['makefile', 'mk', 'just', 'justfile'],
}

const BY_NAME = new Map(Object.entries(ALIASES).flatMap(([name, aliases]) => aliases.map(alias => [alias, name as Name])))

const EXTENSION = /\.([^./]+)$/
const BASENAME = /[^/]*$/

// The language a code block's info string or a file name stands for, undefined for one view does not know.
export function languageOf(nameOrPath: string): Name | undefined {
  const base = (BASENAME.exec(nameOrPath)?.[0] ?? '').toLowerCase()
  const extension = EXTENSION.exec(base)?.[1]

  return BY_NAME.get(extension ?? base) ?? BY_NAME.get(base.replace(LEADING_DOT, ''))
}

type Paint = (text: string) => string

// A token painted a line at a time, so a colour never runs over the bar or the gutter in front of the next line.
function paintLines(text: string, paint: Paint): string {
  return text.split('\n').map(line => line === '' ? line : paint(line)).join('\n')
}

function stringEnd(source: string, start: number, quote: string): number {
  const triple = TRIPLE_QUOTES.find(each => source.startsWith(each, start))
  const multiline = quote === '`' || triple !== undefined
  const closer = triple ?? quote
  let at = start + closer.length

  while (at < source.length) {
    const char = source.charAt(at)

    if (char === '\\') {
      at += 2
    }
    else if (source.startsWith(closer, at)) {
      return at + closer.length
    }
    else if (char === '\n' && !multiline) {
      return at
    }
    else {
      at++
    }
  }

  return source.length
}

// The line starts of a key, a setting or a section, drawn before the rest of the line is read as code.
function lineLead(line: string, language: Language, theme: Theme): { done: string, rest: string } {
  if (language.section?.test(line) === true)
    return { done: theme.heading(line), rest: '' }

  const match = language.key?.exec(line)

  if (match === null || match === undefined)
    return { done: '', rest: line }

  return { done: `${match[1] ?? ''}${theme.accent(match[2] ?? '')}`, rest: line.slice(match[0].length) }
}

// The source with comments, strings, numbers, keywords and keys in the roles of the other CLIs; text it does not recognise stays as it is.
export function highlight(source: string, name: Name, theme: Theme): string {
  const language: Language = LANGUAGES[name]
  const text = source.replaceAll('\r\n', '\n')
  let out = ''
  let at = 0

  while (at < text.length) {
    const lineStart = at === 0 || text.charAt(at - 1) === '\n'

    if (lineStart && (language.key !== undefined || language.section !== undefined)) {
      const lineEnd = text.indexOf('\n', at)
      const line = text.slice(at, lineEnd === -1 ? text.length : lineEnd)
      const { done, rest } = lineLead(line, language, theme)

      if (done !== '') {
        out += done
        at += line.length - rest.length

        continue
      }
    }

    const char = text.charAt(at)
    const comment = language.line.find(each => text.startsWith(each, at))

    if (comment !== undefined) {
      const end = text.indexOf('\n', at)
      const stop = end === -1 ? text.length : end

      out += paintLines(text.slice(at, stop), theme.dim)
      at = stop
    }
    else if (language.block !== undefined && text.startsWith(language.block[0], at)) {
      const end = text.indexOf(language.block[1], at + language.block[0].length)
      const stop = end === -1 ? text.length : end + language.block[1].length

      out += paintLines(text.slice(at, stop), theme.dim)
      at = stop
    }
    else if (language.quotes.includes(char)) {
      const stop = stringEnd(text, at, char)
      const isKey = language.quotedKeys === true && AFTER_KEY.test(text.slice(stop, !text.includes('\n', stop) ? undefined : text.indexOf('\n', stop)))

      out += paintLines(text.slice(at, stop), isKey ? theme.accent : theme.string)
      at = stop
    }
    else if (DIGIT.test(char) && !PREVIOUS_WORD.test(text.slice(Math.max(0, at - 1), at))) {
      const number = NUMBER.exec(text.slice(at))?.[0] ?? char

      out += theme.number(number)
      at += number.length
    }
    else if (language.commands === true && char === '-' && (at === 0 || WHITESPACE.test(text.charAt(at - 1))) && FLAG.test(text.slice(at))) {
      const flag = FLAG.exec(text.slice(at))?.[0] ?? char

      out += theme.number(flag)
      at += flag.length
    }
    else if (WORD_START.test(char)) {
      const word = WORD.exec(text.slice(at))?.[0] ?? char
      const before = text.slice(text.lastIndexOf('\n', at - 1) + 1, at)
      const command = language.commands === true && (PROMPT.test(before) || COMMAND_END.test(before))

      if (language.keywords.has(word))
        out += theme.keyword(word)
      else
        out += command && !word.startsWith('$') ? theme.accent(word) : word

      at += word.length
    }
    else {
      out += char
      at++
    }
  }

  return out
}

// The code behind a gutter of line numbers on a terminal; a `lineNumbers` of false leaves it bare.
export function renderCode(source: string, name: Name | undefined, theme: Theme, lineNumbers: boolean): string {
  const text = source.replace(TRAILING_NEWLINE, '')
  const shown = name === undefined ? text : highlight(text, name, theme)

  if (!lineNumbers)
    return `${shown}\n`

  const lines = shown.split('\n')
  const digits = String(lines.length).length

  return `${lines.map((line, index) => `${theme.dim(`${String(index + 1).padStart(digits)} │`)} ${line}`.trimEnd()).join('\n')}\n`
}
