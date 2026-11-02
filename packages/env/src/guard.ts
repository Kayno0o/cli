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
const RG_VALUE_OPTIONS = new Set(['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-j', '-d', '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--context', '--after-context', '--before-context', '--threads', '--max-depth', '--max-filesize'])
const PATTERN_OPTIONS = new Set(['-e', '-f', '--regexp', '--file'])
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

// Whether code run by an interpreter names an env file or dumps the environment of a Python process.
function codeReadsEnv(found: readonly Word[]): boolean {
  return found.some((word, i) => (word.isProse || CODE_OPTIONS.has(found[i - 1]?.text ?? '')) && (PYTHON_ENVIRON.test(word.text) || [...word.text.matchAll(ENV_NAME_IN_CODE)].some(match => isEnvFile(match[1] ?? ''))))
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
  const found = words(piece.command)

  if (program === '' || HARMLESS.has(program) || (program === 'git' && GIT_HARMLESS.has(args[0] ?? '')))
    return false

  if (INTERPRETERS.has(program) && codeReadsEnv(found))
    return true

  return found.some((word, index) => !word.isProse && variantsOf(word, variables).some(variant => namesEnvFile(variant, found[index - 1]?.text, word.hasGlob)))
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

  if (!isGrep && program !== 'rg' && program !== 'ag')
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

// True when the command would read, write or print an env file or the whole environment; an env file named only inside a quoted message or a heredoc body is text, and a container's environment piped through `redact` is masked.
export function touchesEnv(command: string, options: { hasTrackedEnv?: boolean } = {}): boolean {
  if (ENV_DUMP.test(command))
    return true

  if (substitutions(command).some(each => touchesEnv(each, options)))
    return true

  const pieces = splitCommand(command)
  const variables = variablesOf(command)

  return pieces.some((piece, index) => {
    const { program, args } = parseCommand(piece.command)

    if (readsEnv(piece, variables) || searchesEnv(program, args))
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
