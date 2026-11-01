import { parseCommand, splitCommand, tokenize } from '@kaynooo/cli-kit/shell'
import { writes } from './guard'

const SQL_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'pgcli', 'mycli', 'sqlite3'])
// These write whatever they are given.
const WRITING_TOOLS = new Set(['dropdb', 'createdb', 'pg_restore'])
const CONSOLE_PROGRAMS = new Set(['php', 'docker', 'symfony', 'console', 'artisan'])
// The options carrying the statement itself, which never names the database.
const STATEMENT_OPTIONS = new Set(['-c', '--command', '-e', '--execute'])
const FILE_OPTIONS = new Set(['-f', '--file', '<'])
// Programs piping their arguments into a client, `echo "DELETE ..." | psql`.
const PRINTERS = new Set(['echo', 'printf'])
const LIST_OPTIONS = new Set(['-l', '--list'])
// Console commands that write a schema or rows, Doctrine's and Laravel's.
const WRITING_CONSOLE = /^(?:doctrine:(?:migrations:(?:migrate|execute|rollup)|schema:(?:update|create|drop)|database:(?:create|drop)|fixtures:load)|migrate(?::\w+)?|db:(?:seed|wipe))$/
// A database, env file, compose file or service named for tests: `booki_test`, `.env.test`, `compose.test.yaml`, `-e test`, `APP_ENV=test`; "latest" is not one.
const TEST_SCOPED = /(?:^|[^a-z])test/i
// The disposable stack git-diff captures on, by its directory `.worktrees/<project>/shot` or its compose project `<project>--shot`.
const SHOT_STACK = /\.worktrees\/[^/\s]+\/shot(?:\/|$)|--shot(?:-|$)/

export const SQL_WRITE = 'Statements that write (INSERT, UPDATE, DELETE, DDL, migrations, fixtures) are handed over: list the exact command for the user to run. Only a clearly test-only database runs them directly.'

function hasWrite(statement: string): boolean {
  return writes(statement).length > 0
}

function programOf(word: string): string {
  return word.split('/').pop() ?? ''
}

// Whether the words name a test-only target; a client's own statement and the files it reads are not targets, and its options only count from the client on, so `docker compose -f compose.test.yaml exec db psql` reads as a compose file.
function isTestScoped(words: readonly string[]): boolean {
  const client = words.findIndex(word => SQL_CLIENTS.has(programOf(word)))

  return words.some((word, i) => (TEST_SCOPED.test(word) || SHOT_STACK.test(word)) && (i <= client || client === -1 || (!STATEMENT_OPTIONS.has(words[i - 1] ?? '') && !FILE_OPTIONS.has(words[i - 1] ?? ''))))
}

// Whether a piece runs a SQL client, anywhere in its words so `docker compose exec db psql` counts.
export function runsSqlClient(command: string): boolean {
  return splitCommand(command).some(piece => tokenize(piece.command).some(word => SQL_CLIENTS.has(programOf(word))))
}

// Why the command is refused, or null; `read` gives the text of a file a client is fed, null when it cannot be read.
export async function sqlViolation(command: string, read: (path: string) => Promise<string | null>): Promise<string | null> {
  const pieces = splitCommand(command)
  // A `cd` into the shot stack covers the pieces after it, until another `cd` leaves it.
  let inShotStack = false

  for (const [index, piece] of pieces.entries()) {
    const words = tokenize(piece.command)
    const { program, args } = parseCommand(piece.command)

    if (program === 'cd')
      inShotStack = SHOT_STACK.test(args[0] ?? '')

    if (inShotStack || isTestScoped(words))
      continue

    if (WRITING_TOOLS.has(program) && !words.some(word => LIST_OPTIONS.has(word)))
      return SQL_WRITE

    if (CONSOLE_PROGRAMS.has(program) && words.some(word => WRITING_CONSOLE.test(word)))
      return SQL_WRITE

    const client = words.findIndex(word => SQL_CLIENTS.has(programOf(word)))

    if (client === -1)
      continue

    const files = words.filter((_, i) => i > client && FILE_OPTIONS.has(words[i - 1] ?? ''))
    const before = index === 0 ? null : parseCommand(pieces[index - 1]?.command ?? '')
    // the statements a client is given: its own options, its heredoc body, the files it reads and what a printer pipes into it
    const statements = [
      ...words.filter((_, i) => i > client && STATEMENT_OPTIONS.has(words[i - 1] ?? '')),
      piece.text === piece.command ? '' : piece.text.slice(piece.text.indexOf('\n')),
      before !== null && PRINTERS.has(before.program) ? before.args.join(' ') : '',
      ...(await Promise.all(files.map(read))).map(text => text ?? ''),
    ]

    if (statements.some(hasWrite))
      return SQL_WRITE
  }

  return null
}
