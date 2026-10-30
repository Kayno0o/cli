import type { Piece } from '@kaynooo/cli-kit'
import { parseCommand, splitCommand, words } from '@kaynooo/cli-kit'

// A dotenv file or a glob reaching one: `.env`, `.env.local`, `.env.*`, `HEAD~1:api/.env` as git spells a file at a revision, but not the templates that hold no values.
const ENV_FILE = /(?:^|[/:])\.env(?:[.*][\w.*-]*)?$/
const TEMPLATE = /\.(?:example|sample|template|dist|defaults)$/
const REDIRECT = /^\d*[<>]+&?/
// `$(...)` or a backquoted command, run even inside double quotes and unquoted heredocs.
const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g
// Code printing the whole environment Bun filled from the .env files.
const ENV_DUMP = /(?:console\.\w+|JSON\.stringify|Object\.(?:entries|keys|values)|print)\(\s*process\.env\s*[,)]/
// Programs that name an env file without reading it: listing, testing, or loading it into a process that prints nothing.
const HARMLESS = new Set(['ev', 'redact', 'ls', 'stat', 'test', '[', '[[', 'touch'])
const GIT_HARMLESS = new Set(['check-ignore', 'ls-files', 'status'])
// Programs printing a process's whole environment.
const ENV_PRINTERS = new Set(['env', 'printenv'])
const DOCKER = new Set(['docker', 'docker-compose'])
// `compose config` options printing names, never values.
const CONFIG_LISTS = new Set(['--services', '--volumes', '--profiles', '--images', '--networks', '--hash', '-q', '--quiet'])
const FORMAT_OPTIONS = new Set(['-f', '--format'])
// An inspect format still printing the environment, or everything.
const WHOLE_FORMAT = /Env|\{\{\s*json\s+\.\s*\}\}|^json$/

export const USE_EV = '.env files hold secrets that must never reach the transcript, so they are not read, edited or printed directly. Use `ev` instead: `ev list`, `ev get KEY` (masked), `ev grep <regex>` for the keys matching it, `ev show <rev>:<file>` for one at a git revision, `printf %s "$value" | ev set KEY [file]` (`--empty` for an empty value), `ev unset KEY`, `ev mv KEY --from .env --to .env.local`, `ev diff a b`, `ev missing`; and pipe output that may carry a secret through `redact`, as `docker compose exec <svc> printenv | redact` or `docker compose config | redact`. If `ev` is missing: `bun install -g @kaynooo/env-tools`.'

export function isEnvFile(path: string): boolean {
  return ENV_FILE.test(path) && !TEMPLATE.test(path)
}

// A word naming an env file, past any redirect and `--flag=` prefix; an `--env-file` value only loads it, so it is let through.
function namesEnvFile(word: string, previous: string | undefined): boolean {
  if (previous === '--env-file' || word.startsWith('--env-file='))
    return false

  const bare = word.replace(REDIRECT, '')

  return isEnvFile(bare.includes('=') ? bare.slice(bare.indexOf('=') + 1) : bare)
}

// A docker call printing a container's environment: `env` or `printenv` run through exec, `compose config` and `inspect`, which spell it out.
function dumpsContainerEnv(program: string, args: string[]): boolean {
  if (!DOCKER.has(program))
    return false

  const rest = program === 'docker' && args[0] === 'compose' ? args.slice(1) : args
  const exec = rest.indexOf('exec')

  if (exec !== -1 && rest.slice(exec + 1).some(word => ENV_PRINTERS.has(word)))
    return true

  if (rest.includes('config'))
    return !rest.some(word => CONFIG_LISTS.has(word))

  if (program !== 'docker' || (args[0] !== 'inspect' && (args[0] !== 'container' || args[1] !== 'inspect')))
    return false

  const format = args.find((_, i) => FORMAT_OPTIONS.has(args[i - 1] ?? '')) ?? args.find(word => word.startsWith('--format='))?.slice('--format='.length)

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

  const pieces = splitCommand(command)

  return pieces.some((piece, index) => {
    for (const [, dollar, backquote] of `${piece.command}\n${piece.expanded}`.matchAll(SUBSTITUTION)) {
      if (touchesEnv(dollar ?? backquote ?? ''))
        return true
    }

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
