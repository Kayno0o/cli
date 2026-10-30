import type { Piece } from '@kaynooo/cli-kit'
import { parseCommand, splitCommand, substitutions, tokenize, words } from '@kaynooo/cli-kit'
import { ENV_FILE, TEMPLATE } from './files'

const REDIRECT = /^\d*[<>]+&?/
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

export const USE_EV = '.env files hold secrets that must never reach the transcript, so they are not read, edited or printed directly. Use `ev` instead: `ev list`, `ev get KEY` (masked), `ev grep <regex>` for the keys matching it, `ev show <rev>:<file>` for one at a git revision, `printf %s "$value" | ev set KEY [file]` (`--empty` for an empty value), `ev unset KEY`, `ev mv KEY --from .env --to .env.local`, `ev diff a b`, `ev missing`; and pipe output that may carry a secret through `redact`, as `docker compose exec <svc> printenv | redact` or `docker compose config | redact`. If `ev` is missing: `bun install -g @kaynooo/env-tools`.'

// The name past the last `/`, or past the `:` of `HEAD~1:api/.env` as git spells a file at a revision; the `.env*` glob reaches one too.
export function isEnvFile(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf(':')) + 1)

  return (ENV_FILE.test(name) || name === '.env*') && !TEMPLATE.test(name)
}

// A word naming an env file, past any redirect and `--flag=` prefix; an `--env-file` value only loads it, so it is let through.
function namesEnvFile(word: string, previous: string | undefined): boolean {
  if (previous === '--env-file' || word.startsWith('--env-file='))
    return false

  const bare = word.replace(REDIRECT, '')

  return isEnvFile(bare.includes('=') ? bare.slice(bare.indexOf('=') + 1) : bare)
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

function readsEnv(piece: Piece): boolean {
  const { program, args } = parseCommand(piece.command)
  const found = words(piece.command)

  if (program === '' || HARMLESS.has(program) || (program === 'git' && GIT_HARMLESS.has(args[0] ?? '')))
    return false

  return found.some((word, index) => !word.isProse && namesEnvFile(word.text, found[index - 1]?.text))
}

// True when the command would read, write or print an env file or the whole environment; an env file named only inside a quoted message or a heredoc body is text, and a container's environment piped through `redact` is masked.
export function touchesEnv(command: string): boolean {
  if (ENV_DUMP.test(command))
    return true

  if (substitutions(command).some(touchesEnv))
    return true

  const pieces = splitCommand(command)

  return pieces.some((piece, index) => {
    if (readsEnv(piece))
      return true

    const { program, args } = parseCommand(piece.command)

    if (!dumpsContainerEnv(program, args))
      return false

    // a redact further down its pipeline masks what the container prints
    for (let at = index; pieces[at]?.separator === '|'; at++) {
      if (parseCommand(pieces[at + 1]?.command ?? '').program === 'redact')
        return false
    }

    return true
  })
}
