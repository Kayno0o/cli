import { parseCommand, splitCommand, tokenize } from '@kaynooo/cli-kit/shell'
import { writes } from './guard'

const SQL_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'pgcli', 'mycli', 'sqlite3'])
// These write whatever they are given.
const WRITING_TOOLS = new Set(['dropdb', 'createdb', 'pg_restore'])
const CONSOLE_PROGRAMS = new Set(['php', 'docker', 'symfony', 'console', 'artisan'])
// The short options of each client taking a value (the next word, or what follows the letter), which are not flags in a cluster such as `-tAc`.
const VALUE_SHORTS: Record<string, string> = { psql: 'cdfhLopPRTUvF', pgcli: 'dhUpW', mysql: 'eDhPSuTA', mariadb: 'eDhPSuTA', mycli: 'eDhPSuTA', sqlite3: '' }
// The short option carrying the statement itself, which never names the database.
const STATEMENT_SHORTS: Record<string, string> = { psql: 'c', pgcli: 'c', mysql: 'e', mariadb: 'e', mycli: 'e', sqlite3: '' }
const FILE_SHORTS: Record<string, string> = { psql: 'f', pgcli: '', mysql: '', mariadb: '', mycli: '', sqlite3: '' }
const IS_MYSQL = new Set(['mysql', 'mariadb', 'mycli'])
const DATABASE_SHORTS = new Set(['d', 'D'])
const STATEMENT_LONGS = new Set(['--command', '--execute'])
const DATABASE_LONGS = new Set(['--dbname', '--database'])
const VALUE_LONGS = new Set(['--host', '--port', '--username', '--user', '--output', '--set', '--variable', '--field-separator', '--record-separator', '--pset', '--log-file', '--socket'])
// Programs piping their arguments into a client, `echo "DELETE ..." | psql`.
const PRINTERS = new Set(['echo', 'printf'])
const LIST_OPTIONS = new Set(['-l', '--list'])
const REDIRECT_ONLY = /^\d*(?:>|>>|>&|&>|>\||<&|<>)$/
const REDIRECT_START = /^\d*>|^&>/
const URL_DATABASE = /^[a-z][a-z\d+.-]*:\/\/[^/]*\/([^?#]*)/i
// Console commands that write a schema or rows, Doctrine's and Laravel's.
const WRITING_CONSOLE = /^(?:doctrine:(?:migrations:(?:migrate|execute|rollup)|schema:(?:update|create|drop)|database:(?:create|drop)|fixtures:load)|migrate(?::\w+)?|db:(?:seed|wipe))$/
// A database, env file, compose file or service named for tests: `booki_test`, `.env.test`, `compose.test.yaml`, `-e test`, `APP_ENV=test`; "latest" is not one.
const TEST_SCOPED = /(?:^|[^a-z])test/i
// The disposable stack git-diff captures on, by its directory `.worktrees/<project>/shot` or its compose project `<project>--shot`.
const SHOT_STACK = /\.worktrees\/[^/\s]+\/shot(?:\/|$)|--shot(?:-|$)/
// Files a client cannot be read from without hanging or reading a device.
const DEVICE_PATH = /^\/(?:dev|proc|sys)\//
const STDIN_PATHS = new Set(['-', '/dev/stdin'])

export const SQL_WRITE = 'Statements that write (INSERT, UPDATE, DELETE, DDL, migrations, fixtures) are handed over: list the exact command for the user to run. Only a clearly test-only database runs them directly.'
export const SQL_UNREADABLE = 'A file this SQL client is fed cannot be read here (missing, a device, or too large), so what it runs is unknown. Hand over the exact command for the user to run.'

// What a client is given on its command line: the statements, the files it reads, the databases it names and its other operands.
interface ClientInput { statements: string[], files: string[], databases: string[], operands: string[] }

function hasWrite(statement: string): boolean {
  return writes(statement).length > 0
}

function programOf(word: string): string {
  return word.split('/').pop() ?? ''
}

function databaseOf(operand: string): string {
  return URL_DATABASE.exec(operand)?.[1] ?? operand
}

// Reads a client's words, `-c`, `-tAc STATEMENT`, `--command=...`, `-fFILE`, `--file FILE`, `< FILE`, `<<< 'STATEMENT'` and the database it names included.
function clientInput(name: string, args: readonly string[]): ClientInput {
  const input: ClientInput = { statements: [], files: [], databases: [], operands: [] }
  const valueShorts = VALUE_SHORTS[name] ?? ''
  let isOperands = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (isOperands) {
      input.operands.push(arg)
    }
    else if (arg === '--') {
      isOperands = true
    }
    else if (arg.startsWith('<<<')) {
      input.statements.push(arg.length > 3 ? arg.slice(3) : (args[++i] ?? ''))
    }
    else if (arg.startsWith('<<')) {
      continue
    }
    else if (arg === '<') {
      input.files.push(args[++i] ?? '')
    }
    else if (arg.startsWith('<')) {
      input.files.push(arg.slice(1))
    }
    else if (REDIRECT_ONLY.test(arg)) {
      i++
    }
    else if (REDIRECT_START.test(arg)) {
      continue
    }
    else if (arg.startsWith('--')) {
      const [option = '', ...rest] = arg.split('=')
      const attached = rest.length > 0 ? rest.join('=') : undefined
      const value = attached ?? args[i + 1] ?? ''

      if (STATEMENT_LONGS.has(option))
        input.statements.push(value)
      else if (option === '--file')
        input.files.push(value)
      else if (DATABASE_LONGS.has(option))
        input.databases.push(databaseOf(value))

      if (attached === undefined && (STATEMENT_LONGS.has(option) || option === '--file' || DATABASE_LONGS.has(option) || VALUE_LONGS.has(option)))
        i++
    }
    else if (arg === '-cmd' && name === 'sqlite3') {
      input.statements.push(args[++i] ?? '')
    }
    else if (arg.startsWith('-p') && IS_MYSQL.has(name)) {
      // mysql's password is attached to the option, whatever letters it holds
      continue
    }
    else if (arg.startsWith('-') && arg.length > 1) {
      for (const [index, letter] of [...arg.slice(1)].entries()) {
        if (!valueShorts.includes(letter))
          continue

        // the value is what follows the letter, else the next word
        const attached = arg.slice(index + 2)
        const value = attached === '' ? (args[++i] ?? '') : attached

        if (STATEMENT_SHORTS[name]?.includes(letter) === true)
          input.statements.push(value)
        else if (FILE_SHORTS[name]?.includes(letter) === true)
          input.files.push(value)
        else if (DATABASE_SHORTS.has(letter))
          input.databases.push(databaseOf(value))

        break
      }
    }
    else {
      input.operands.push(arg)
    }
  }

  if (name === 'sqlite3')
    input.statements.push(...input.operands.slice(1))
  else if (input.operands[0] !== undefined)
    input.databases.push(databaseOf(input.operands[0]))

  return input
}

// Whether the words name a test-only target: what comes before the client (a compose file, an environment, a service) or the database it names; a client's statements and files never count.
function isTestScoped(words: readonly string[], client: number, input: ClientInput | null): boolean {
  if (client === -1)
    return words.some(word => TEST_SCOPED.test(word) || SHOT_STACK.test(word))

  return words.slice(0, client).some(word => TEST_SCOPED.test(word) || SHOT_STACK.test(word)) || (input?.databases ?? []).some(name => TEST_SCOPED.test(name))
}

// Whether a piece runs a SQL client, anywhere in its words so `docker compose exec db psql` counts.
export function runsSqlClient(command: string): boolean {
  return splitCommand(command).some(piece => tokenize(piece.command).some(word => SQL_CLIENTS.has(programOf(word))))
}

// The text of a file a client reads, null when it cannot be: a device or a missing file.
async function fileText(path: string, read: (path: string) => Promise<string | null>): Promise<string | null> {
  return DEVICE_PATH.test(path) ? null : read(path)
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

    const client = words.findIndex(word => SQL_CLIENTS.has(programOf(word)))
    const input = client === -1 ? null : clientInput(programOf(words[client] ?? ''), words.slice(client + 1))

    if (inShotStack || isTestScoped(words, client, input))
      continue

    if (WRITING_TOOLS.has(program) && !words.some(word => LIST_OPTIONS.has(word)))
      return SQL_WRITE

    if (CONSOLE_PROGRAMS.has(program) && words.some(word => WRITING_CONSOLE.test(word)))
      return SQL_WRITE

    if (input === null)
      continue

    const before = index === 0 ? null : parseCommand(pieces[index - 1]?.command ?? '')
    const isPiped = pieces[index - 1]?.separator === '|'
    // a file the client reads from stdin is its heredoc or what is piped in, not a path
    const paths = input.files.filter(path => !STDIN_PATHS.has(path))
    const texts = await Promise.all([...paths, ...(isPiped && before?.program === 'cat' ? before.args.filter(arg => !arg.startsWith('-')) : [])].map(async path => fileText(path, read)))

    if (texts.includes(null))
      return SQL_UNREADABLE

    // the statements a client is given: its own options, its heredoc body, the files it reads and what a printer pipes into it
    const statements = [
      ...input.statements,
      ...piece.heredocs,
      isPiped && before !== null && PRINTERS.has(before.program) ? before.args.join(' ') : '',
      ...texts.map(text => text ?? ''),
    ]

    if (statements.some(hasWrite))
      return SQL_WRITE
  }

  return null
}
