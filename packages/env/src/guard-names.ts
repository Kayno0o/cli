import type { Piece, Word } from '@kaynooo/cli-kit/shell'
import { braceExpand, parseCommand, splitCommand, tokenize, words } from '@kaynooo/cli-kit/shell'
import { GIT_EXCLUDE } from './guard-dumps'
import { isEnvFile, namesEnvFile } from './guard-paths'
import { GREP_VALUE_OPTIONS, GREPS, listsFiles, patternIndex, printsNamesOnly, RG_VALUE_OPTIONS } from './guard-search'

const ENV_NAME_IN_CODE = /(?:^|[^\w.-])(\.env(?:\.[\w.-]*\w)?|\.envrc)(?![\w-])/g
const PYTHON_ENVIRON = /\bos\.environ\b(?!\s*(?:\[|\.get\b))/
const VARIABLE = /\$(?:(\w+)|\{(\w+)\})/
const ASSIGNMENT = /^\w+=/
const MAX_VARIANTS = 64
// Programs running the code they are given, which may read an env file or print the environment.
const INTERPRETERS = new Set(['bun', 'deno', 'node', 'python', 'python3', 'ruby', 'perl', 'php', 'lua', 'awk', 'gawk'])
const CODE_OPTIONS = new Set(['-e', '-c', '-p', '-E', '-pe', '-r', '--eval', '--print', '--command'])
// What a script needs to open a file or run a command: file, process and shell APIs, imports, command substitution and backticks.
const CAN_REACH_FILES = /read|write|open|exec|spawn|system|popen|import|require|eval|load|fetch|glob|stream|source|getline|constructor|file(?!s\b)|\bcat\b|\b(?:Bun|Deno|fs|os|io|sh|bash|process|globalThis|window|Function|qx)\b|\$\s*[`({]|`/i
const DECLARERS = new Set(['export', 'declare', 'local', 'readonly', 'typeset'])
// Programs that name an env file without reading it: listing, testing, or loading it into a process that prints nothing.
const HARMLESS = new Set(['ev', 'redact', 'ls', 'stat', 'test', '[', '[[', 'touch'])
const GIT_HARMLESS = new Set(['check-ignore', 'ls-files', 'status'])

// The values each variable is given in a command, by assignment, `export` or a `for` list.
export function variablesOf(command: string): Map<string, string[]> {
  const variables = new Map<string, string[]>()
  const add = (assignment: string) => {
    const at = assignment.indexOf('=')
    const name = assignment.slice(0, at)

    variables.set(name, [...variables.get(name) ?? [], assignment.slice(at + 1)])
  }

  for (const piece of splitCommand(command)) {
    const { program, args, assignments } = parseCommand(piece.command)
    const tokens = tokenize(piece.command)

    const declared = DECLARERS.has(program) ? args.filter(arg => ASSIGNMENT.test(arg)) : []

    for (const assignment of [...assignments, ...declared])
      add(assignment)

    if (tokens[0] === 'for' && tokens[2] === 'in' && tokens[1] !== undefined)
      variables.set(tokens[1], [...variables.get(tokens[1]) ?? [], ...tokens.slice(3)])
  }

  return variables
}

// The words a word stands for once the variables it uses and its `{a,b}` lists are replaced.
function variantsOf(word: Word, variables: ReadonlyMap<string, string[]>): string[] {
  let found = [word.text]

  for (let round = 0; round < 4 && found.some(each => VARIABLE.test(each)); round++) {
    found = found.flatMap((each) => {
      const match = VARIABLE.exec(each)
      const values = variables.get(match?.[1] ?? match?.[2] ?? '')

      if (match === null || values === undefined)
        return [each.replace(VARIABLE, '')]

      return values.map(value => each.slice(0, match.index) + value + each.slice(match.index + match[0].length))
    }).slice(0, MAX_VARIANTS)
  }

  return found.flatMap(each => word.hasBrace ? braceExpand(each) : [each])
}

// Whether code names an env file and could open it: a mention in code that calls nothing able to read a file, run a command or import a module (`/\.env files/.test(x)`) is only text. Deliberately generous, so a doubtful script stays refused.
function codeReadsEnvFile(code: string): boolean {
  return [...code.matchAll(ENV_NAME_IN_CODE)].some(match => isEnvFile(match[1] ?? '')) && CAN_REACH_FILES.test(code)
}

// Whether code run by an interpreter, given as an argument or fed as a heredoc, reads an env file or dumps the environment of a Python process.
function codeReadsEnv(found: readonly Word[], heredocs: readonly string[]): boolean {
  const sources = [...found.filter((word, i) => word.isProse || CODE_OPTIONS.has(found[i - 1]?.text ?? '')).map(word => word.text), ...heredocs]

  return sources.some(code => PYTHON_ENVIRON.test(code) || codeReadsEnvFile(code))
}

export function readsEnv(piece: Piece, variables: ReadonlyMap<string, string[]>): boolean {
  const { program, args } = parseCommand(piece.command)

  if (program === '' || HARMLESS.has(program) || (program === 'git' && GIT_HARMLESS.has(args[0] ?? '')))
    return false

  if (INTERPRETERS.has(program) && codeReadsEnv(words(piece.command), piece.heredocs))
    return true

  if (printsNamesOnly(program, args) || listsFiles(program, args))
    return false

  return namesEnv(piece, variables)
}

// Whether a piece has a word naming an env file, whatever it does with it.
export function namesEnv(piece: Piece, variables: ReadonlyMap<string, string[]>): boolean {
  const { program, args } = parseCommand(piece.command)
  const found = words(piece.command)

  // a git pathspec like `:!.env` leaves the file out
  const isExclusion = (word: Word) => program === 'git' && GIT_EXCLUDE.test(word.text)
  // the pattern of a search is a regex, not a file
  const isSearch = GREPS.has(program) || program === 'rg' || program === 'ag'
  const patternAt = isSearch ? patternIndex(args, GREPS.has(program) ? GREP_VALUE_OPTIONS : RG_VALUE_OPTIONS) : undefined
  const pattern = patternAt === undefined ? undefined : found.length - args.length + patternAt

  return found.some((word, index) => index !== pattern && !word.isProse && !isExclusion(word) && variantsOf(word, variables).some(variant => namesEnvFile(variant, found[index - 1]?.text, word.hasGlob)))
}
