import type { Piece, Word } from '@kaynooo/cli-kit/shell'
import { braceExpand, parseCommand, splitCommand, substitutions, tokenize, words } from '@kaynooo/cli-kit/shell'
import { ENV_FILE, TEMPLATE } from './files'

const REDIRECT = /^\d*[<>]+&?/
const ENVRC = '.envrc'
const PROC_ENVIRON = /^\/proc\/[^/]+\/environ$/
const ENV_NAME_IN_CODE = /(?:^|[^\w.-])(\.env(?:\.[\w.-]*\w)?|\.envrc)(?![\w-])/g
const PYTHON_ENVIRON = /\bos\.environ\b(?!\s*(?:\[|\.get\b))/
const VARIABLE = /\$(?:(\w+)|\{(\w+)\})/
const ASSIGNMENT = /^\w+=/
const SHORT_FLAGS = /^-[a-z]+$/i
const OPENER = /^[({]+/
// Names a glob could stand for, to tell whether it reaches an env file.
const ENV_SAMPLES = ['.env', '.env.local', '.env.production', '.envrc']
const MAX_VARIANTS = 64
// Programs running the code they are given, which may read an env file or print the environment.
const INTERPRETERS = new Set(['bun', 'deno', 'node', 'python', 'python3', 'ruby', 'perl', 'php', 'lua', 'awk', 'gawk'])
const CODE_OPTIONS = new Set(['-e', '-c', '-p', '-E', '-pe', '-r', '--eval', '--print', '--command'])
const GREPS = new Set(['grep', 'egrep', 'fgrep'])
const GREP_VALUE_OPTIONS = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--include', '--exclude', '--exclude-dir', '--exclude-from', '--context', '--after-context', '--before-context', '--label', '--binary-files', '--directories', '--devices'])
const RG_VALUE_OPTIONS = new Set(['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-j', '-d', '-r', '-M', '-E', '--replace', '--max-columns', '--encoding', '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--context', '--after-context', '--before-context', '--threads', '--max-depth', '--max-filesize'])
const PATTERN_OPTIONS = new Set(['-e', '-f', '--regexp', '--file'])
// rg's -L follows links, it does not list the files without a match
const GREP_NAMES_ONLY = new Set('lLcq')
const RG_NAMES_ONLY = new Set('lcq')
const NAMES_ONLY_LONG = new Set(['--files-with-matches', '--files-without-match', '--count', '--count-matches', '--quiet', '--silent'])
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from'])
// What a script needs to open a file or run a command: file, process and shell APIs, imports, command substitution and backticks.
const CAN_REACH_FILES = /read|write|open|exec|spawn|system|popen|import|require|eval|load|fetch|glob|stream|source|getline|constructor|file(?!s\b)|\bcat\b|\b(?:Bun|Deno|fs|os|io|sh|bash|process|globalThis|window|Function|qx)\b|\$\s*[`({]|`/i
const HIDDEN_FLAGS = /^(?:-u{2,}|--hidden|-\.)$/i
const REGEX_SPECIALS = /[.+^${}()|\\[\]]/g
const NEGATED_CLASS = /^!/
const GLOB_CHAR = /[*?[]/
const HAS_R = /r/i
const DUMP_FLAGS = /^-[a-z]*[px]/
const DECLARERS = new Set(['export', 'declare', 'local', 'readonly', 'typeset'])
// A directory listing everything under it: the current one, its parents, home, the root.
const WHOLE_TREE_OPERAND = /^(?:(?:\.\.?\/?)+|~\/?|\$HOME\/?|\/)$/
// Git commands whose output carries the content of tracked files.
const GIT_PATCHES = new Set(['diff', 'log', 'show', 'whatchanged', 'format-patch', 'grep'])
const GIT_NO_PATCH = new Set(['--stat', '--numstat', '--shortstat', '--name-only', '--name-status', '--summary', '-s', '--no-patch', '--check', '--quiet'])
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const GIT_PATCH_FLAGS = new Set(['-p', '-u', '--patch', '-c', '--cc', '--patch-with-stat', '--patch-with-raw'])
const GIT_EXCLUDE = /^:(?:!|\^|\(exclude\))/
// An option leaving env files out of a search: grep's `--exclude=.env*`, ripgrep's `-g '!.env*'`.
const EXCLUDES_ENV = /^(?:--exclude(?:-dir)?=.*env|(?:--glob=|--iglob=|-g)?!.*env)/
const EXCLUDE_OPTIONS = new Set(['--exclude', '--exclude-dir', '-g', '--glob', '--iglob'])
// Code printing the whole environment Bun filled from the .env files.
const ENV_DUMP = /(?:console\.\w+|JSON\.stringify|Object\.(?:entries|keys|values)|print)\(\s*process\.env\s*[,)]/
// Programs that name an env file without reading it: listing, testing, or loading it into a process that prints nothing.
const HARMLESS = new Set(['ev', 'redact', 'ls', 'stat', 'test', '[', '[[', 'touch'])
const GIT_HARMLESS = new Set(['check-ignore', 'ls-files', 'status'])
// Programs an `xargs` can run on a listing of names without printing a line of the files.
const XARGS_SAFE = new Set(['ls', 'stat', 'wc', 'test', '[', 'touch', 'echo', 'printf', 'basename', 'dirname', 'ev', 'redact', ''])
// Programs printing a process's whole environment.
const ENV_PRINTERS = new Set(['env', 'printenv'])
const DOCKER = new Set(['docker', 'docker-compose'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'ash'])
// Options taking a value, before a docker or compose subcommand, and before exec's container.
const DOCKER_VALUE_OPTIONS = new Set(['-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory', '--ansi', '--progress', '--parallel', '-H', '--host', '-c', '--context', '--config', '-l', '--log-level'])
const EXEC_VALUE_OPTIONS = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--index', '--detach-keys'])
// `compose config` options printing names, never values.
const CONFIG_LISTS = new Set(['--services', '--volumes', '--profiles', '--images', '--networks', '--hash', '-q', '--quiet'])
const FORMAT_OPTIONS = new Set(['-f', '--format'])
// An inspect format still printing the environment, or everything.
const WHOLE_FORMAT = /Env|\{\{\s*json\s+\.\s*\}\}|^json$/

export const USE_EV = '.env files hold secrets that must never reach the transcript, so they are not read, edited or printed directly. Use `ev` instead: `ev list`, `ev get KEY` (masked), `ev grep <regex>` for the keys matching it, `ev show <rev>:<file>` for one at a git revision, `printf %s "$value" | ev set KEY [file]` (`--empty` for an empty value), `ev unset KEY`, `ev cp KEY --from .env --to .env.local`, `ev mv KEY --from .env --to .env.local`, `ev diff a b`, `ev missing`; and pipe output that may carry a secret through `redact`, as `docker compose exec <svc> printenv | redact` or `docker compose config | redact`. If `ev` is missing: `bun install -g @kaynooo/env-tools`.'

export const USE_EV_SEARCH = 'To search them, `ev grep <regex>` prints the matching keys, masked. `grep -l`, `-L` and `-c` (file names and counts) are allowed, and a tree-wide search can run as `rg <regex>`, which skips gitignored files, or `grep -r --exclude=\'.env*\' <regex> .`.'

// Whether a piece is a grep-family search, which the refusal then advises on.
export function isSearchCommand(piece: Piece): boolean {
  const { program } = parseCommand(piece.command)

  return GREPS.has(program) || program === 'rg' || program === 'ag'
}

// The name past the last `/`, or past the `:` of `HEAD~1:api/.env` as git spells a file at a revision; the `.env*` glob reaches one too.
export function isEnvFile(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf(':')) + 1)

  return (ENV_FILE.test(name) || name === '.env*' || name === ENVRC) && !TEMPLATE.test(name)
}

// The regex a shell glob stands for, `*` and `?` matching a name's characters and `[...]` a class.
function globRegex(glob: string): RegExp {
  let source = ''

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? ''
    const close = char === '[' ? glob.indexOf(']', i + 2) : -1

    if (char === '*') {
      source += '.*'
    }
    else if (char === '?') {
      source += '.'
    }
    else if (close === -1) {
      source += char.replace(REGEX_SPECIALS, String.raw`\$&`)
    }
    else {
      source += `[${glob.slice(i + 1, close).replace(NEGATED_CLASS, '^')}]`
      i = close
    }
  }

  return new RegExp(`^${source}$`)
}

// A dotted glob such as `.en?` or `.e*` reaching an env file; the shell never matches a leading dot with a wildcard, so the glob has to spell it.
function globReachesEnv(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)

  if (!name.startsWith('.') || !GLOB_CHAR.test(name))
    return false

  const regex = globRegex(name)

  return ENV_SAMPLES.some(sample => regex.test(sample))
}

// Whether the path or glob a file tool is given reaches an env file, `{a,b}` lists and wildcards included.
export function reachesEnvFile(path: string): boolean {
  return braceExpand(path).some(each => isEnvFile(each) || globReachesEnv(each))
}

// The path a word stands for, past any redirect and `--flag=` prefix.
function targetOf(word: string): string {
  const bare = word.replace(REDIRECT, '')

  return bare.includes('=') ? bare.slice(bare.indexOf('=') + 1) : bare
}

// A word naming an env file, past any redirect and `--flag=` prefix; an `--env-file` value only loads it, so it is let through.
function namesEnvFile(word: string, previous: string | undefined, isGlob: boolean): boolean {
  if (previous === '--env-file' || word.startsWith('--env-file=') || word.startsWith('--exclude') || EXCLUDE_OPTIONS.has(previous ?? ''))
    return false

  const path = targetOf(word)

  return isEnvFile(path) || PROC_ENVIRON.test(path) || (isGlob && globReachesEnv(path))
}

// The values each variable is given in a command, by assignment, `export` or a `for` list.
function variablesOf(command: string): Map<string, string[]> {
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

// Whether the grep family lists file names or counts matches only (`grep -l`, `-L`, `-c`, `-q`), which prints no line of a file.
function printsNamesOnly(program: string, args: readonly string[]): boolean {
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
function listsFiles(program: string, args: readonly string[]): boolean {
  return program === 'find' && !args.some(arg => FIND_ACTIONS.has(arg))
}

// The letters of the short options taking a value.
function valueLettersOf(valueOptions: ReadonlySet<string>): Set<string> {
  return new Set([...valueOptions].filter(option => option.length === 2 && !option.startsWith('--')).map(option => option.slice(1)))
}

// The index in `args` of the pattern a search program is given, undefined when `-e` or `-f` gives it, even glued to a cluster as in `-ne KEY`: it is a regex, never a file.
function patternIndex(args: readonly string[], valueOptions: ReadonlySet<string>): number | undefined {
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

// The index of the first word that is no option, past the values the options given take.
function firstOperand(words: readonly string[], valueOptions: ReadonlySet<string>): number {
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''

    if (valueOptions.has(word))
      i++
    else if (!word.startsWith('-'))
      return i
  }

  return words.length
}

// The command a container runs prints its environment: `env` or `printenv` as the program, or as one run by `sh -c`.
function printsEnv([program = '', ...args]: readonly string[]): boolean {
  if (SHELLS.has(program) && args[0] === '-c')
    return splitCommand(args[1] ?? '').some(piece => ENV_PRINTERS.has(tokenize(piece.command)[0] ?? ''))

  return ENV_PRINTERS.has(program)
}

// A docker call printing a container's environment: `env` or `printenv` run through exec, `compose config` and `inspect`, which spell it out.
function dumpsContainerEnv(program: string, args: string[]): boolean {
  if (!DOCKER.has(program))
    return false

  const afterOptions = (words: readonly string[]) => words.slice(firstOperand(words, DOCKER_VALUE_OPTIONS))
  let rest = afterOptions(args)
  const isCompose = program === 'docker-compose' || rest[0] === 'compose'

  if (program === 'docker' && isCompose)
    rest = afterOptions(rest.slice(1))

  const [subcommand = '', ...after] = rest

  if (subcommand === 'exec')
    return printsEnv(after.slice(firstOperand(after, EXEC_VALUE_OPTIONS) + 1))

  if (isCompose)
    return subcommand === 'config' && !after.some(word => CONFIG_LISTS.has(word))

  if (subcommand !== 'inspect' && (subcommand !== 'container' || after[0] !== 'inspect'))
    return false

  const format = after.find((_, i) => FORMAT_OPTIONS.has(after[i - 1] ?? '')) ?? after.find(word => word.startsWith('--format='))?.slice('--format='.length)

  return format === undefined || WHOLE_FORMAT.test(format)
}

function readsEnv(piece: Piece, variables: ReadonlyMap<string, string[]>): boolean {
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
function namesEnv(piece: Piece, variables: ReadonlyMap<string, string[]>): boolean {
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
function searchesEnv(program: string, args: readonly string[]): boolean {
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

// Programs printing the environment of the shell they run in: `env` and `printenv` alone, `export -p`, `declare -x`, a bare `set`.
function dumpsEnvironment(program: string, args: readonly string[], tokens: readonly string[]): boolean {
  const isBare = args.every(arg => arg.startsWith('-'))

  if (program === 'printenv' || program === 'export')
    return isBare

  if (program === 'declare' || program === 'typeset')
    return isBare && args.some(arg => DUMP_FLAGS.test(arg))

  if (program === 'set')
    return args.length === 0

  return program === '' && tokens.some(token => token.replace(OPENER, '') === 'env')
}

// Whether a git command prints the content of a tracked env file: a patch or a search with no pathspec leaving env files out.
function printsTrackedEnv(program: string, args: readonly string[]): boolean {
  if (program !== 'git')
    return false

  const at = args.findIndex((arg, i) => !arg.startsWith('-') && !GIT_VALUE_OPTIONS.has(args[i - 1] ?? ''))
  const name = args[at] ?? ''
  const rest = args.slice(at + 1)

  if (!GIT_PATCHES.has(name) || rest.some(arg => GIT_EXCLUDE.test(arg)))
    return false

  if (name === 'grep')
    return true

  if (name === 'log' || name === 'whatchanged')
    return rest.some(arg => GIT_PATCH_FLAGS.has(arg))

  return !rest.some(arg => GIT_NO_PATCH.has(arg))
}

// Whether the piece is an `xargs` running a command that may print the files it is given the names of, on a listing naming an env file further up its pipeline (harmless alone, but `xargs` opens each name).
function xargsReadsListedEnv(pieces: readonly Piece[], index: number, variables: ReadonlyMap<string, string[]>): boolean {
  const command = pieces[index]?.command ?? ''
  const { program, isWrapped } = parseCommand(command)

  // parseCommand sees through `xargs` to the command it runs
  if (!isWrapped || !tokenize(command).includes('xargs') || XARGS_SAFE.has(program))
    return false

  for (let at = index - 1; at >= 0 && pieces[at]?.separator.startsWith('|'); at--) {
    if (namesEnv(pieces[at] as Piece, variables))
      return true
  }

  return false
}

// The pieces of a command that would read, write or print an env file or the whole environment.
export function touchingPieces(command: string, options: { hasTrackedEnv?: boolean } = {}): Piece[] {
  const pieces = splitCommand(command)

  if (ENV_DUMP.test(command) || substitutions(command).some(each => touchesEnv(each, options)))
    return pieces

  const variables = variablesOf(command)

  return pieces.filter((piece, index) => {
    const { program, args } = parseCommand(piece.command)

    if (readsEnv(piece, variables) || searchesEnv(program, args) || xargsReadsListedEnv(pieces, index, variables))
      return true

    const isDump = dumpsContainerEnv(program, args) || dumpsEnvironment(program, args, tokenize(piece.command)) || (options.hasTrackedEnv === true && printsTrackedEnv(program, args))

    if (!isDump)
      return false

    // a redact further down its pipeline masks what the command prints
    for (let at = index; pieces[at]?.separator === '|'; at++) {
      if (parseCommand(pieces[at + 1]?.command ?? '').program === 'redact')
        return false
    }

    return true
  })
}

// True when the command would read, write or print an env file or the whole environment; an env file named only inside a quoted message or a heredoc body is text, and a container's environment piped through `redact` is masked.
export function touchesEnv(command: string, options: { hasTrackedEnv?: boolean } = {}): boolean {
  return touchingPieces(command, options).length > 0
}
