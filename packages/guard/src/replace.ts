import type { Pair } from '@kaynooo/cli-edit/src/replace.ts'
import { parseCommand, shellQuote, splitCommand } from '@kaynooo/cli-kit/shell'
import { HEREDOC_OPENER, heredocBody } from './commit'

const PYTHON = /^python[\d.]*$/
const SCRIPT_RUNNERS = new Set(['bun', 'node'])
const EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print'])
const REPLACE_CALL = /\.(replace|replaceAll)\(/g
// Calls taking the path they write or read as first argument, methods reading or writing the file they are called on, and `open` in either form.
const WRITE_CALL = /\b(?:Bun\.write|writeFileSync|writeFile)\(/g
const READ_CALL = /\b(?:readFileSync|readFile)\(/g
const WRITE_METHOD = /\.(?:write_text|write_bytes)\(/g
const READ_METHOD = /\.(?:text|json|bytes|arrayBuffer|read_text|read_bytes)\(/g
const OPEN_CALL = /(\.)open\(|(?<![\w$.])open\(/g
// A handle on a file, its first argument the path: `Bun.file(p)`, `Path(p)`, `open(p)`.
const HANDLE = /^(?:await\s+)?(?:Bun\.file|(?:pathlib\.)?Path|open)\(/
const HANDLE_BEFORE = /(?:Bun\.file|(?<![\w$])Path|(?<![\w$.])open)$/
const RECEIVER_NAME = /[A-Z_$][\w$.]*$/i
const NAME_BEFORE = /[\w$.]*$/
const OPEN_MODE = /^[rwaxbt+U]+$/
const WRITE_MODE = /[wax+]/
const READ_MODE = /[r+]/
const MODE_KEYWORD = /^mode\s*=\s*/
const WHITESPACE = /\s+/g
const IDENTIFIER = /^[A-Z_$][\w$]*/i
const ONLY_IDENTIFIER = /^[A-Z_$][\w$]*$/i
const COUNT_CHECK = /\.count\(/g
const COUNT_EQUALS = /^\s*\)\s*==\s*(\d+)/
const PYTHON_COUNT = /^\s*,\s*(\d+)\s*\)/
const SPACE = /^\s*/
const COMMA = /^\s*,\s*/
const REGEX_FLAGS = /^[gm]*$/
const PLAIN_WORD = /^[\w@%+=:,./*?-]+$/
const SED_SEPARATORS = /^[\s;]*/
const SED_SEPARATOR = /[\s;]/
const BRE_ESCAPED = new Map([['(', '('], [')', ')'], ['{', '{'], ['}', '}'], ['+', '+'], ['?', '?'], ['|', '|']])
const POSIX_CLASSES = new Map([['[:space:]', String.raw`\s`], ['[:digit:]', String.raw`\d`], ['[:alpha:]', 'a-zA-Z'], ['[:alnum:]', 'a-zA-Z0-9'], ['[:upper:]', 'A-Z'], ['[:lower:]', 'a-z'], ['[:blank:]', String.raw` \t`]])
const ESCAPES = new Map([['n', '\n'], ['t', '\t']])
const BRE_METAS = new Set(['.', '[', ']', '*', '^', '$'])
const ERE_METAS = new Set([...BRE_METAS, '+', '?', '(', ')', '{', '}', '|'])
const JS_SPECIALS = /[.*+?^${}()|[\]\\]/g

const WHY = 'writes nothing unless each file matches as often as expected, where it rewrites files whatever it matched'
const GENERIC = 'Run `sub --from <text> --to <text> <file>...` instead (`--regex`, `--all`, `-n N`, `--dry-run --diff` to look first). For several replacements or multi-line text, pipe SEARCH/REPLACE blocks from a quoted heredoc, no escaping: `sub <file> <<\'EOF\'`, then `<<<<<<< SEARCH`, the old lines, `=======`, the new lines and `>>>>>>> REPLACE` each on its own line, then `EOF`; blocks apply in order, a line naming a file before a block makes it edit that file.'

interface Literal { value: string, end: number, flags?: string }

// The string literal opening at `at` in a Python or JS script (quotes, triple quotes, a `r` or `b` prefix, a JS regex literal when `regex` is set), undefined when it is none or holds an interpolation.
function literalAt(text: string, at: number, regex = false): Literal | undefined {
  let start = at
  const isRaw = text[start] === 'r' || text[start] === 'R'

  if (isRaw || text[start] === 'b')
    start++

  const quote = text[start] ?? ''

  if (regex && quote === '/')
    return regexAt(text, start)

  if (quote !== '\'' && quote !== '"' && quote !== '`')
    return undefined

  const fence = text.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote
  let value = ''

  for (let i = start + fence.length; i < text.length; i++) {
    const char = text[i] ?? ''

    if (text.startsWith(fence, i))
      return { value, end: i + fence.length }

    if (quote === '`' && text.startsWith('${', i))
      return undefined

    if (char === '\\' && !isRaw) {
      const next = text[++i] ?? ''

      value += ESCAPES.get(next) ?? (next === '\n' ? '' : next)
    }
    else {
      value += char
    }
  }

  return undefined
}

function regexAt(text: string, start: number): Literal | undefined {
  let source = ''
  let inClass = false

  for (let i = start + 1; i < text.length; i++) {
    const char = text[i] ?? ''

    if (char === '\n')
      return undefined

    if (char === '\\') {
      source += char + (text[++i] ?? '')

      continue
    }

    if (char === '/' && !inClass) {
      const flags = IDENTIFIER.exec(text.slice(i + 1))?.[0] ?? ''

      return { value: source, end: i + 1 + flags.length, flags }
    }

    if (char === '[' || char === ']')
      inClass = char === '['

    source += char
  }

  return undefined
}

function skip(text: string, at: number, pattern: RegExp): number | undefined {
  const found = pattern.exec(text.slice(at))

  return found === null ? undefined : at + found[0].length
}

// The literal at `at`, or the one the variable named there was last assigned before it (`old = '''...'''`), its end the end of the name.
function valueAt(script: string, at: number, regex = false): Literal | undefined {
  const literal = literalAt(script, at, regex)
  const name = literal === undefined ? IDENTIFIER.exec(script.slice(at))?.[0] : undefined

  if (literal !== undefined || name === undefined)
    return literal

  const assignments = [...script.slice(0, at).matchAll(new RegExp(String.raw`(?<![\w.$])${name.replaceAll('$', String.raw`\$`)}\s*=(?!=)\s*`, 'g'))]
  const last = assignments.at(-1)
  const assigned = last === undefined ? undefined : literalAt(script, last.index + last[0].length, regex)

  return assigned === undefined ? undefined : { ...assigned, end: at + name.length }
}

// The index past a quoted string opening at `at`, or the script's length when it never closes.
function quotedEnd(script: string, at: number): number {
  const quote = script[at]

  for (let i = at + 1; i < script.length; i++) {
    if (script[i] === '\\')
      i++
    else if (script[i] === quote)
      return i + 1
  }

  return script.length
}

// The expression from `at` up to the comma, closing bracket or statement end that ends it at its own depth.
function expressionAt(script: string, at: number): string {
  let depth = 0

  for (let i = at; i < script.length;) {
    const char = script[i] ?? ''

    if (char === '\'' || char === '"' || char === '`') {
      i = quotedEnd(script, i)

      continue
    }

    if ('([{'.includes(char))
      depth++
    else if (')]}'.includes(char) && depth-- === 0)
      return script.slice(at, i)
    else if (depth === 0 && (char === ',' || char === ';' || char === '\n'))
      return script.slice(at, i)

    i++
  }

  return script.slice(at)
}

// The `(` opening the bracket that closes at `close`, undefined when it opens nowhere.
function openingParen(script: string, close: number): number | undefined {
  let depth = 0

  for (let i = close; i >= 0; i--) {
    if (script[i] === ')')
      depth++
    else if (script[i] === '(' && --depth === 0)
      return i
  }

  return undefined
}

// A file a script reads or writes: `key` the same for two references to the same file, `path` the path when it is written out.
interface Target { key: string, path?: string }

// The file the expression at `at` names: a literal path, a handle on one, a variable followed to what it was assigned, or else the expression's own text.
function targetAt(script: string, at: number, depth = 0): Target | undefined {
  const start = skip(script, at, SPACE) ?? at
  const literal = literalAt(script, start)

  if (literal !== undefined)
    return { key: literal.value, path: literal.value }

  const text = expressionAt(script, start).trimEnd()
  const handle = HANDLE.exec(text)

  if (handle !== null && depth < 8)
    return targetAt(script, start + handle[0].length, depth + 1)

  if (ONLY_IDENTIFIER.test(text))
    return nameTarget(script, text, start, depth)

  return text === '' ? undefined : { key: text.replaceAll(WHITESPACE, '') }
}

// The file a variable names, from its last assignment before `at` when that is a path, a handle or another variable; the name itself otherwise, such as one read from argv.
function nameTarget(script: string, name: string, at: number, depth: number): Target {
  const assignments = [...script.slice(0, at).matchAll(new RegExp(String.raw`(?<![\w.$])${name.replaceAll('$', String.raw`\$`)}\s*=(?!=)\s*`, 'g'))]
  const last = assignments.at(-1)

  if (last === undefined || depth >= 8)
    return { key: name }

  const from = last.index + last[0].length
  const text = expressionAt(script, from).trimEnd()
  const followed = literalAt(script, from) !== undefined || HANDLE.test(text) || ONLY_IDENTIFIER.test(text)

  return followed ? targetAt(script, from, depth + 1) ?? { key: name } : { key: name }
}

// The file the method called at `.` index `dot` acts on: `Path(p).read_text()`, `p.read_text()`, `(await Bun.file(p).text())`.
function receiverTarget(script: string, dot: number): Target | undefined {
  if (script[dot - 1] === ')') {
    const open = openingParen(script, dot - 1)

    if (open === undefined)
      return undefined

    const before = script.slice(0, open)

    if (HANDLE_BEFORE.test(before))
      return targetAt(script, open + 1)

    const name = NAME_BEFORE.exec(before)?.[0] ?? ''

    return { key: (name + script.slice(open, dot)).replaceAll(WHITESPACE, '') }
  }

  const name = RECEIVER_NAME.exec(script.slice(0, dot))?.[0]

  if (name === undefined)
    return undefined

  return ONLY_IDENTIFIER.test(name) ? nameTarget(script, name, dot - name.length, 0) : { key: name }
}

// The files the script reads and those it writes, a write undefined when its file cannot be told; an `open` whose mode is not written out counts as a read.
function fileAccess(script: string): { reads: Set<string>, writes: (Target | undefined)[] } {
  const reads = new Set<string>()
  const writes: (Target | undefined)[] = []
  const read = (target: Target | undefined) => target !== undefined && reads.add(target.key)

  for (const call of script.matchAll(WRITE_CALL))
    writes.push(targetAt(script, call.index + call[0].length))

  for (const call of script.matchAll(READ_CALL))
    read(targetAt(script, call.index + call[0].length))

  for (const call of script.matchAll(WRITE_METHOD))
    writes.push(receiverTarget(script, call.index))

  for (const call of script.matchAll(READ_METHOD))
    read(receiverTarget(script, call.index))

  for (const call of script.matchAll(OPEN_CALL)) {
    const after = call.index + call[0].length
    const isMethod = call[1] !== undefined
    const target = isMethod ? receiverTarget(script, call.index) : targetAt(script, after)
    const modeAt = isMethod ? after : skip(script, after + expressionAt(script, after).length, COMMA)
    const mode = modeAt === undefined || script[modeAt] === ')' ? 'r' : literalAt(script, skip(script, modeAt, MODE_KEYWORD) ?? modeAt)?.value

    const isWrite = mode !== undefined && OPEN_MODE.test(mode) && WRITE_MODE.test(mode)

    if (isWrite)
      writes.push(target)

    if (!isWrite || READ_MODE.test(mode))
      read(target)
  }

  return { reads, writes }
}

// The count a Python script asserts for each text, `assert s.count(old) == 1`.
function assertedCounts(script: string): Map<string, number> {
  const counts = new Map<string, number>()

  for (const call of script.matchAll(COUNT_CHECK)) {
    const text = valueAt(script, call.index + call[0].length)
    const equals = text === undefined ? null : COUNT_EQUALS.exec(script.slice(text.end))

    if (text !== undefined && equals !== null)
      counts.set(text.value, Number(equals[1]))
  }

  return counts
}

// The script's replace calls as sub pairs, undefined when one takes anything but literals.
function scriptPairs(script: string, isPython: boolean): Pair[] | undefined {
  const pairs: Pair[] = []
  const counts = isPython ? assertedCounts(script) : new Map<string, number>()

  for (const call of script.matchAll(REPLACE_CALL)) {
    const from = valueAt(script, skip(script, call.index + call[0].length, SPACE) ?? 0, !isPython)
    const comma = from === undefined ? undefined : skip(script, from.end, COMMA)
    const to = comma === undefined ? undefined : valueAt(script, comma)

    if (from === undefined || to === undefined)
      return undefined

    if (from.flags !== undefined) {
      if (!REGEX_FLAGS.test(from.flags))
        return undefined

      pairs.push({ from: from.value, to: to.value, regex: true, ...(from.flags.includes('g') ? { all: true } : {}) })

      continue
    }

    const limit = isPython ? PYTHON_COUNT.exec(script.slice(to.end)) : null
    // Python's replace takes every match unless given a count or a count is asserted; JS's replace takes the first.
    const count = limit === null ? counts.get(from.value) : Number(limit[1])
    const all = call[1] === 'replaceAll' || (isPython && count === undefined)
    const pair: Pair = { from: from.value, to: to.value }

    if (all)
      pair.all = true
    else if (count !== undefined && count !== 1)
      pair.count = count

    pairs.push(pair)
  }

  return pairs.length === 0 ? undefined : pairs
}

interface SedArgs { scripts: string[], files: string[], isExtended: boolean, isInPlace: boolean, isPlain: boolean }

function sedArgs(args: readonly string[]): SedArgs {
  const sed: SedArgs = { scripts: [], files: [], isExtended: false, isInPlace: false, isPlain: true }
  const operands: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (arg === '--in-place' || arg.startsWith('--in-place='))
      sed.isInPlace = true
    else if (arg === '--regexp-extended')
      sed.isExtended = true
    else if (arg === '--expression')
      sed.scripts.push(args[++i] ?? '')
    else if (arg.startsWith('--expression='))
      sed.scripts.push(arg.slice('--expression='.length))
    else if (arg.startsWith('--'))
      sed.isPlain = false
    else if (arg.startsWith('-') && arg.length > 1)
      i += sedCluster(arg, args[i + 1], sed)
    else
      operands.push(arg)
  }

  if (sed.scripts.length === 0)
    sed.scripts.push(operands.shift() ?? '')

  sed.files = operands

  return sed
}

// Reads a short option cluster such as `-Ei` into the arguments, returning how many next words it took; GNU sed takes the rest of the cluster after `i` as a backup suffix.
function sedCluster(arg: string, next: string | undefined, sed: SedArgs): number {
  for (const [index, flag] of [...arg.slice(1)].entries()) {
    if (flag === 'i') {
      sed.isInPlace = true

      return 0
    }

    if (flag === 'E' || flag === 'r') {
      sed.isExtended = true
    }
    else if (flag === 'e') {
      const value = index === arg.length - 2 ? next : arg.slice(index + 2)

      sed.scripts.push(value ?? '')

      return index === arg.length - 2 ? 1 : 0
    }
    else if (flag !== 's' && flag !== 'u') {
      sed.isPlain = false
    }
  }

  return 0
}

// The text up to the next unescaped delimiter, from `at`, undefined when the expression ends first.
function sedPart(script: string, at: number, delimiter: string): { part: string, end: number } | undefined {
  for (let i = at; i < script.length; i++) {
    if (script[i] === '\\')
      i++
    else if (script[i] === delimiter)
      return { part: script.slice(at, i), end: i + 1 }
  }

  return undefined
}

// A sed pattern as the literal text it matches, undefined when it needs a regex.
function sedLiteral(pattern: string, delimiter: string, metas: ReadonlySet<string>): string | undefined {
  let text = ''

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? ''

    if (char !== '\\') {
      if (metas.has(char))
        return undefined

      text += char

      continue
    }

    const next = pattern[++i] ?? ''

    if (ESCAPES.has(next))
      text += ESCAPES.get(next)
    else if (next === delimiter || next === '\\' || BRE_METAS.has(next) || (metas === ERE_METAS && ERE_METAS.has(next)))
      text += next
    else
      return undefined
  }

  return text
}

// A sed pattern as a JS regular expression source: BRE's `\(` groups and `\+` turn plain, its bare `(` and `+` escaped, POSIX classes spelled out.
function sedRegex(pattern: string, delimiter: string, isExtended: boolean): string {
  let source = ''

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? ''
    const posix = [...POSIX_CLASSES].find(([name]) => pattern.startsWith(name, i))

    if (posix !== undefined) {
      source += posix[1]
      i += posix[0].length - 1
    }
    else if (char === '\\') {
      const next = pattern[++i] ?? ''

      if (next === delimiter)
        source += next.replaceAll(JS_SPECIALS, String.raw`\$&`)
      else
        source += !isExtended && BRE_ESCAPED.has(next) ? next : `\\${next}`
    }
    else {
      source += !isExtended && BRE_ESCAPED.has(char) ? `\\${char}` : char
    }
  }

  return source
}

// A sed replacement for a literal pattern (`&` is the pattern itself) or a regex one (`&` and `\1` become `$&` and `$1`), undefined when it names a group a literal lacks.
function sedReplacement(replacement: string, literal: string | undefined): string | undefined {
  let text = ''

  for (let i = 0; i < replacement.length; i++) {
    const char = replacement[i] ?? ''

    if (char === '&') {
      text += literal ?? '$&'
    }
    else if (char === '$' && literal === undefined) {
      text += '$$'
    }
    else if (char === '\\') {
      const next = replacement[++i] ?? ''

      if (next >= '1' && next <= '9' && literal === undefined)
        text += `$${next}`
      else if (next >= '0' && next <= '9')
        return undefined
      else
        text += ESCAPES.get(next) ?? (next === '$' && literal === undefined ? '$$' : next)
    }
    else {
      text += char
    }
  }

  return text
}

// The `s` commands of a sed script as sub pairs, undefined for any other command, an address or a flag besides `g`.
function sedPairs(script: string, isExtended: boolean): Pair[] | undefined {
  const pairs: Pair[] = []

  for (let at = 0; at < script.length;) {
    at = skip(script, at, SED_SEPARATORS) ?? at

    if (at >= script.length)
      break

    const delimiter = script[at + 1] ?? ''

    if (script[at] !== 's' || delimiter === '' || delimiter === '\\' || delimiter === '\n')
      return undefined

    const pattern = sedPart(script, at + 2, delimiter)
    const replacement = pattern === undefined ? undefined : sedPart(script, pattern.end, delimiter)

    if (pattern === undefined || replacement === undefined)
      return undefined

    const isGlobal = script[replacement.end] === 'g'

    at = replacement.end + (isGlobal ? 1 : 0)

    if (at < script.length && !SED_SEPARATOR.test(script[at] ?? ''))
      return undefined

    const literal = sedLiteral(pattern.part, delimiter, isExtended ? ERE_METAS : BRE_METAS)
    const to = sedReplacement(replacement.part, literal)

    if (to === undefined)
      return undefined

    pairs.push({ from: literal ?? sedRegex(pattern.part, delimiter, isExtended), to, ...(literal === undefined ? { regex: true } : {}), ...(isGlobal ? { all: true } : {}) })
  }

  return pairs.length === 0 ? undefined : pairs
}

// A file as given, a glob left for the shell to expand.
function fileWord(path: string): string {
  return PLAIN_WORD.test(path) ? path : shellQuote(path)
}

function flagsOf(pair: Pair): string {
  return [pair.regex === true ? ' --regex' : '', pair.all === true ? ' --all' : '', pair.count === undefined ? '' : ` -n ${pair.count}`].join('')
}

// SEARCH/REPLACE blocks for the pairs, undefined when they cannot be written as blocks: flags that differ between pairs, or a text holding the heredoc's own terminator.
function blocksOf(pairs: readonly Pair[]): string | undefined {
  const [first] = pairs

  if (first === undefined || pairs.some(pair => flagsOf(pair) !== flagsOf(first)))
    return undefined

  const lines = new Set(pairs.flatMap(pair => [...pair.from.split('\n'), ...pair.to.split('\n')]))

  if (lines.has('EOF'))
    return undefined

  let width = 7

  while (lines.has('='.repeat(width)) || lines.has(`${'>'.repeat(width)} REPLACE`))
    width++

  return pairs.map(pair => `${'<'.repeat(width)} SEARCH\n${pair.from}\n${'='.repeat(width)}\n${pair.to}\n${'>'.repeat(width)} REPLACE`).join('\n')
}

// The sub command doing what the pairs do in the files: flags for one single-line pair, SEARCH/REPLACE blocks in a heredoc for several pairs or multi-line text, `--pairs` JSON when blocks cannot carry them.
export function subCommand(pairs: readonly Pair[], files: readonly string[]): string {
  const targets = files.length === 0 ? '<file>' : files.map(fileWord).join(' ')
  const [pair] = pairs

  if (pairs.length === 1 && pair !== undefined && !pair.from.includes('\n') && !pair.to.includes('\n'))
    return `sub --from ${shellQuote(pair.from)} --to ${shellQuote(pair.to)}${flagsOf(pair)} ${targets}`

  const blocks = pair === undefined || pairs.some(({ from }) => from === '') ? undefined : blocksOf(pairs)

  if (blocks !== undefined)
    return `sub${pair === undefined ? '' : flagsOf(pair)} ${targets} <<'EOF'\n${blocks}\nEOF`

  return `sub --pairs - ${targets} <<'PAIRS'\n${JSON.stringify(pairs)}\nPAIRS`
}

function route(what: string, pairs: Pair[] | undefined, files: string[]): string {
  return pairs === undefined ? `${what} ${GENERIC}` : `${what} Run this instead, which ${WHY}:\n${subCommand(pairs, files)}`
}

// The script a python, bun or node piece runs inline (`-c`, `-e`, or a heredoc on stdin), null when it runs a file.
function inlineScript(program: string, args: readonly string[], text: string): string | null {
  const flags = PYTHON.test(program) ? new Set(['-c']) : EVAL_FLAGS
  const flag = args.findIndex(arg => flags.has(arg))

  if (flag !== -1)
    return args[flag + 1] ?? null

  const reads = args.every(arg => arg === '-' || arg.startsWith('<<') || (program === 'bun' && arg === 'run'))

  return reads ? heredocBody(text, HEREDOC_OPENER)?.body ?? null : null
}

// Why an in-place edit in the command goes through sub instead, with the sub command doing the same where it can be read; null when there is none.
export function replaceViolation(command: string): string | null {
  for (const piece of splitCommand(command)) {
    const { program, args } = parseCommand(piece.command)

    if (program === 'sed') {
      const sed = sedArgs(args)

      if (sed.isInPlace)
        return route('`sed -i` rewrites files without checking what it matched.', sed.isPlain && sed.scripts.length > 0 ? sedPairs(sed.scripts.join('\n'), sed.isExtended) : undefined, sed.files)

      continue
    }

    const isPython = PYTHON.test(program)
    const script = isPython || SCRIPT_RUNNERS.has(program) ? inlineScript(program, args, piece.text) : null

    if (script === null || script.search(REPLACE_CALL) === -1)
      continue

    const { reads, writes } = fileAccess(script)
    const edited = writes.filter(target => target !== undefined && reads.has(target.key))

    // A script writing only files it never reads, such as a merge into a new file, edits nothing in place; one whose writes cannot all be told gets no sub command, its replace calls maybe unrelated to them.
    if (edited.length === 0 && !writes.includes(undefined))
      continue

    const pairs = edited.length === 0 ? undefined : scriptPairs(script, isPython)
    const paths = new Set(edited.flatMap(target => target?.path ?? []))

    return route(`A ${isPython ? 'python' : program} script replacing text in a file is what \`sub\` does with a match-count check.`, pairs, [...paths])
  }

  return null
}
