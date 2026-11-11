import type { Piece } from '@kaynooo/cli-kit/shell'
import { parseCommand, splitCommand, substitutions, tokenize } from '@kaynooo/cli-kit/shell'
import { dumpsContainerEnv, dumpsEnvironment, printsTrackedEnv } from './guard-dumps'
import { readsEnv, variablesOf } from './guard-names'
import { loopReadsListedEnv, runnerReadsListedEnv } from './guard-pipes'
import { searchesEnv } from './guard-search'

// Code printing the whole environment Bun filled from the .env files.
const ENV_DUMP = /(?:console\.\w+|JSON\.stringify|Object\.(?:entries|keys|values)|print)\(\s*process\.env\s*[,)]/

export const USE_EV = '.env files hold secrets that must never reach the transcript, so they are not read, edited or printed directly. Use `ev` instead: `ev list`, `ev get KEY` (masked), `ev grep <regex>` for the keys matching it, `ev show <rev>:<file>` for one at a git revision, `printf %s "$value" | ev set KEY [file]` (`--empty` for an empty value), `ev unset KEY`, `ev cp KEY --from .env --to .env.local`, `ev mv KEY --from .env --to .env.local`, `ev diff a b`, `ev missing`; and pipe output that may carry a secret through `ev redact`, as `docker compose exec <svc> printenv | ev redact` or `docker compose config | ev redact`. If `ev` is missing: `bun install -g @kaynooo/cli-env`.'

export const USE_EV_SEARCH = 'To search them, `ev grep <regex>` prints the matching keys, masked. `grep -l`, `-L` and `-c` (file names and counts) are allowed, and a tree-wide search can run as `rg <regex>`, which skips gitignored files, or `grep -r --exclude=\'.env*\' <regex> .`.'

// The pieces of a command that would read, write or print an env file or the whole environment.
export function touchingPieces(command: string, options: { hasTrackedEnv?: boolean } = {}): Piece[] {
  const pieces = splitCommand(command)

  if (ENV_DUMP.test(command) || substitutions(command).some(each => touchesEnv(each, options)))
    return pieces

  const variables = variablesOf(command)

  return pieces.filter((piece, index) => {
    const { program, args } = parseCommand(piece.command)

    if (readsEnv(piece, variables) || searchesEnv(program, args) || runnerReadsListedEnv(pieces, index, variables) || loopReadsListedEnv(pieces, index, variables))
      return true

    const isDump = dumpsContainerEnv(program, args) || dumpsEnvironment(program, args, tokenize(piece.command)) || (options.hasTrackedEnv === true && printsTrackedEnv(program, args))

    if (!isDump)
      return false

    // an `ev redact` further down its pipeline masks what the command prints
    for (let at = index; pieces[at]?.separator === '|'; at++) {
      const next = parseCommand(pieces[at + 1]?.command ?? '')

      if (next.program === 'ev' && next.args[0] === 'redact')
        return false
    }

    return true
  })
}

// True when the command would read, write or print an env file or the whole environment; an env file named only inside a quoted message or a heredoc body is text, and a container's environment piped through `ev redact` is masked.
export function touchesEnv(command: string, options: { hasTrackedEnv?: boolean } = {}): boolean {
  return touchingPieces(command, options).length > 0
}

export { isEnvFile, reachesEnvFile } from './guard-paths'
export { isSearchCommand } from './guard-search'
