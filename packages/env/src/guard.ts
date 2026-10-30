import { parseCommand, splitCommand, words } from '@kaynooo/cli-kit'

// A dotenv file or a glob reaching one: `.env`, `.env.local`, `.env.*`, but not the templates that hold no values.
const ENV_FILE = /(?:^|\/)\.env(?:[.*][\w.*-]*)?$/
const TEMPLATE = /\.(?:example|sample|template|dist|defaults)$/
const REDIRECT = /^\d*[<>]+&?/
// `$(...)` or a backquoted command, run even inside double quotes.
const SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g
// Code printing the whole environment Bun filled from the .env files.
const ENV_DUMP = /(?:console\.\w+|JSON\.stringify|Object\.(?:entries|keys|values)|print)\(\s*process\.env\s*[,)]/
// Programs that name an env file without reading it: listing, testing, or loading it into a process that prints nothing.
const HARMLESS = new Set(['ev', 'redact', 'ls', 'stat', 'test', '[', '[[', 'touch'])
const GIT_HARMLESS = new Set(['check-ignore', 'ls-files', 'status'])

export const USE_EV = '.env files hold secrets that must never reach the transcript, so they are not read, edited or printed directly. Use `ev` instead: `ev list`, `ev get KEY` (masked), `printf %s "$value" | ev set KEY [file]`, `ev unset KEY`, `ev mv KEY --from .env --to .env.local`, `ev diff a b`, `ev missing`; and pipe output that may carry a secret through `redact`. If `ev` is missing: `bun install -g @kaynooo/env-tools`.'

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

// True when the command would read, write or print an env file or the whole environment; an env file named only inside a quoted message or a heredoc body is text.
export function touchesEnv(command: string): boolean {
  if (ENV_DUMP.test(command))
    return true

  for (const [, dollar, backquote] of command.matchAll(SUBSTITUTION)) {
    if (touchesEnv(dollar ?? backquote ?? ''))
      return true
  }

  return splitCommand(command).some((piece) => {
    const { program, args } = parseCommand(piece.command)
    const found = words(piece.command)

    if (program === '' || HARMLESS.has(program) || (program === 'git' && GIT_HARMLESS.has(args[0] ?? '')))
      return false

    return found.some((word, index) => !word.isProse && namesEnvFile(word.text, found[index - 1]?.text))
  })
}
