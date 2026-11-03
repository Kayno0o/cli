import type { Piece } from '@kaynooo/cli-kit/shell'
import { parseCommand } from '@kaynooo/cli-kit/shell'
import { EXCLUDE_OPTIONS } from './guard-paths'

const ENV_NAME_IN_PATTERN = /(?:^|[^\w-])\.env(?![\w-])/
const SHORT_FLAGS = /^-[a-z]+$/i

export const GREPS = new Set(['grep', 'egrep', 'fgrep'])
export const GREP_VALUE_OPTIONS = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--include', '--exclude', '--exclude-dir', '--exclude-from', '--context', '--after-context', '--before-context', '--label', '--binary-files', '--directories', '--devices'])
export const RG_VALUE_OPTIONS = new Set(['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-j', '-d', '-r', '-M', '-E', '--replace', '--max-columns', '--encoding', '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--context', '--after-context', '--before-context', '--threads', '--max-depth', '--max-filesize'])
const PATTERN_OPTIONS = new Set(['-e', '-f', '--regexp', '--file'])
// rg's -L follows links, it does not list the files without a match
const GREP_NAMES_ONLY = new Set('lLcq')
const RG_NAMES_ONLY = new Set('lcq')
const NAMES_ONLY_LONG = new Set(['--files-with-matches', '--files-without-match', '--count', '--count-matches', '--quiet', '--silent'])
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from'])
const HIDDEN_FLAGS = /^(?:-u{2,}|--hidden|-\.)$/i
const HAS_R = /r/i
// A directory listing everything under it: the current one, its parents, home, the root.
const WHOLE_TREE_OPERAND = /^(?:(?:\.\.?\/?)+|~\/?|\$HOME\/?|\/)$/
// An option leaving env files out of a search: grep's `--exclude=.env*`, ripgrep's `-g '!.env*'`.
const EXCLUDES_ENV = /^(?:--exclude(?:-dir)?=.*env|(?:--glob=|--iglob=|-g)?!.*env)/

// Whether a piece is a grep-family search, which the refusal then advises on.
export function isSearchCommand(piece: Piece): boolean {
  const { program } = parseCommand(piece.command)

  return GREPS.has(program) || program === 'rg' || program === 'ag'
}

// Whether the grep family lists file names or counts matches only (`grep -l`, `-L`, `-c`, `-q`), which prints no line of a file.
export function printsNamesOnly(program: string, args: readonly string[]): boolean {
  const isGrep = GREPS.has(program)

  if (!isGrep && program !== 'rg')
    return false

  const valueOptions = isGrep ? GREP_VALUE_OPTIONS : RG_VALUE_OPTIONS
  const valueLetters = valueLettersOf(valueOptions)
  const namesOnly = isGrep ? GREP_NAMES_ONLY : RG_NAMES_ONLY
  // the word after an option taking a value is that value, never a flag: `grep -e -l .env` prints lines
  let isValue = false

  for (const arg of args) {
    if (isValue) {
      isValue = false

      continue
    }

    if (arg === '--')
      return false

    if (NAMES_ONLY_LONG.has(arg))
      return true

    if (valueOptions.has(arg)) {
      isValue = true

      continue
    }

    if (!SHORT_FLAGS.test(arg))
      continue

    // a cluster ends at the first option taking a value, which swallows the rest of it or else the next word
    for (const [i, letter] of [...arg.slice(1)].entries()) {
      if (valueLetters.has(letter)) {
        isValue = i === arg.length - 2

        break
      }

      if (namesOnly.has(letter))
        return true
    }
  }

  return false
}

// `find` only printing the names it matches, with no action that runs a command or writes a file.
export function listsFiles(program: string, args: readonly string[]): boolean {
  return program === 'find' && !args.some(arg => FIND_ACTIONS.has(arg))
}

// The letters of the short options taking a value.
function valueLettersOf(valueOptions: ReadonlySet<string>): Set<string> {
  return new Set([...valueOptions].filter(option => option.length === 2 && !option.startsWith('--')).map(option => option.slice(1)))
}

// The index in `args` of the pattern a search program is given, undefined when `-e` or `-f` gives it, even glued to a cluster as in `-ne KEY`: it is a regex, never a file.
export function patternIndex(args: readonly string[], valueOptions: ReadonlySet<string>): number | undefined {
  const valueLetters = valueLettersOf(valueOptions)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (arg.startsWith('--regexp=') || arg.startsWith('--file='))
      return undefined

    if (!arg.startsWith('-') || arg === '-')
      return i

    if (arg.startsWith('--')) {
      if (PATTERN_OPTIONS.has(arg))
        return undefined

      if (valueOptions.has(arg))
        i++

      continue
    }

    // a cluster of short options ends at the first one taking a value, glued after it or the next word
    const at = [...arg.slice(1)].findIndex(letter => valueLetters.has(letter))
    const letter = arg[at + 1]

    if (at === -1)
      continue

    if (letter === 'e' || letter === 'f')
      return undefined

    if (at === arg.length - 2)
      i++
  }

  return undefined
}

// The operands of a search program: its words less the options, their values and the pattern, which `-e` or `-f` may have already given.
function operandsOf(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  const operands: string[] = []
  let hasPattern = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (PATTERN_OPTIONS.has(arg) || arg.startsWith('--regexp=') || arg.startsWith('--file='))
      hasPattern = true

    if (valueOptions.has(arg))
      i++
    else if (!arg.startsWith('-'))
      operands.push(arg)
  }

  return hasPattern ? operands : operands.slice(1)
}

// Whether a search over a whole tree would open an env file: a recursive grep, or ripgrep and ag told to look at hidden files, which they skip by default.
export function searchesEnv(program: string, args: readonly string[]): boolean {
  const isGrep = GREPS.has(program)

  if ((!isGrep && program !== 'rg' && program !== 'ag') || printsNamesOnly(program, args))
    return false

  const isRecursive = args.some(arg => (SHORT_FLAGS.test(arg) && HAS_R.test(arg)) || arg === '--recursive' || arg === '--dereference-recursive')
  const isHidden = args.some(arg => HIDDEN_FLAGS.test(arg) || (program === 'ag' && (arg === '-u' || arg === '--unrestricted')))
  const isLimited = args.some((arg, i) => arg.startsWith('--include') || EXCLUDES_ENV.test(arg) || (EXCLUDE_OPTIONS.has(args[i - 1] ?? '') && arg.includes('env')))

  if (isLimited || (isGrep ? !isRecursive : !isHidden))
    return false

  const operands = operandsOf(args, isGrep ? GREP_VALUE_OPTIONS : RG_VALUE_OPTIONS)

  return operands.length === 0 || operands.some(operand => WHOLE_TREE_OPERAND.test(operand))
}

// Whether the piece is a search whose pattern, its escapes dropped, names an env file (`grep '^\.env'`): fed a listing, what it prints are env file names.
export function searchesEnvNames(piece: Piece): boolean {
  const { program, args } = parseCommand(piece.command)

  if (!GREPS.has(program) && program !== 'rg')
    return false

  const at = patternIndex(args, GREPS.has(program) ? GREP_VALUE_OPTIONS : RG_VALUE_OPTIONS)

  return at !== undefined && ENV_NAME_IN_PATTERN.test((args[at] ?? '').replaceAll('\\', ''))
}
