import type { Piece } from '@kaynooo/cli-kit/shell'
import type { Dialect } from './sql-tokens'
import { parseCommand, splitCommand, tokenize } from '@kaynooo/cli-kit/shell'
import { writes } from './guard'
import { otherDatabases } from './guard-test'

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
const FILE_LONGS = new Set(['--file'])
const KNOWN_LONGS = [...STATEMENT_LONGS, ...FILE_LONGS, ...DATABASE_LONGS, ...VALUE_LONGS]
const LIST_OPTIONS = new Set(['-l', '--list'])
const REDIRECT_ONLY = /^\d*(?:>|>>|>&|&>|>\||<&|<>)$/
const REDIRECT_START = /^\d*>|^&>/
// A connection URL's path, and its query, whose `dbname` libpq reads over the path. libpq knows no fragment: `/app#?dbname=prod` connects to prod, and `/app#x` to a database named `app#x`; mycli's urlparse cuts the fragment instead.
const URL_START = /^[a-z][a-z\d+.-]*:\/\//i
const URL_PATH = /^[a-z][a-z\d+.-]*:\/\/[^/?]*\/?([^?]*)/i
// A libpq conninfo string, `host=h dbname=app user=u`, read pair by pair: a value is quoted with '' and \ escapes, or bare up to a space, where a quote is a plain character and \ still escapes.
const CONNINFO = /^\s*\w+\s*=/
const CONNINFO_PAIR = /\s*(\w+)\s*=\s*(?:'((?:\\[\s\S]|[^'\\])*)'|(?!')((?:\\[\s\S]?|[^\s\\])*))/gy
const ESCAPED = /\\([\s\S]?)/g
// What a conninfo libpq reads differently from this parse counts as naming: a database no test one, so nothing it hides lets a write through.
const UNREAD_CONNINFO = 'a conninfo string not read to its end'
// Console commands that write a schema or rows, Doctrine's and Laravel's.
const WRITING_CONSOLE = /^(?:doctrine:(?:migrations:(?:migrate|execute|rollup)|schema:(?:update|create|drop)|database:(?:create|drop)|fixtures:load)|migrate(?::\w+)?|db:(?:seed|wipe))$/
// A database, env file, compose file or service named for tests: `booki_test`, `.env.test`, `compose.test.yaml`, `-e test`, `APP_ENV=test`; "latest" is not one.
const TEST_SCOPED = /(?:^|[^a-z])test/i
const ASSIGNMENT = /^([A-Z_]\w*)=/i
// The variables that pick an environment or a database; `PGUSER=test_user` or `PGPASSWORD=test` pick neither.
const TARGET_VARIABLE = /(?:^|_|^PG)(?:ENV|ENVIRONMENT|DATABASE|DB|DBNAME|DSN|URL)$|^(?:DB|DATABASE)_NAME$/i
// The disposable stack git-diff captures on, by its directory `.worktrees/<project>/shot` or its compose project `<project>--shot`.
// The options naming the account a command runs as, whose value is no target.
const USER_OPTION = /^(?:-[uU]|--user(?:name)?)$/
const USER_ATTACHED = /^(?:--user(?:name)?=|-[uU].)/
const SHOT_STACK = /\.worktrees\/[^/\s]+\/shot(?:\/|$)|--shot(?:-|$)/
// Files a client cannot be read from without hanging or reading a device.
const DEVICE_PATH = /^\/(?:dev|proc|sys)\//
const STDIN_PATHS = new Set(['-', '/dev/stdin'])

export const SQL_WRITE = 'Statements that write (INSERT, UPDATE, DELETE, DDL, migrations, fixtures) are handed over: list the exact command for the user to run. Only a clearly test-only database runs them directly.'
export const SQL_OTHER_DATABASE = 'A write naming another database than the test one the client connects to (a qualified name, USE, CREATE or DROP DATABASE) reaches past it: hand the exact command over for the user to run.'
const SHELL_SYNTAX = /[$`]/

// Names the file and why it cannot be read, so the fix is clear: a path with a variable is not expanded here, and a file the same command writes does not exist yet when the command is checked.
export function sqlUnreadable(path: string): string {
  let cause = 'missing when the command is checked, or too large'

  if (DEVICE_PATH.test(path))
    cause = 'a device'
  else if (SHELL_SYNTAX.test(path))
    cause = 'its path holds a variable or substitution, which is not expanded here'

  return `The SQL client is fed ${path}, which cannot be read here (${cause}), so what it runs is unknown. Write the file with the file edit tool in its own call and give a literal path, or run it on a database named *_test; otherwise hand over the exact command for the user to run.`
}

// What a client is given on its command line: the statements, the files it reads, the database it connects to when it names one, and its other operands.
interface ClientInput { statements: string[], files: string[], database?: string | undefined, operands: string[] }

function hasWrite(statement: string): boolean {
  // The server behind a client is unknown, so a statement is read as Postgres and as MySQL, and writes if either reading does.
  return writes(statement, 'postgres').length > 0 || writes(statement, 'mysql').length > 0
}

function programOf(word: string): string {
  return word.split('/').pop() ?? ''
}

function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text)
  }
  catch {
    return text
  }
}

// The last `dbname` of a URL's query, its keys percent-decoded as libpq decodes them (`?%64bname=prod`).
function queryDatabase(operand: string): string | undefined {
  const query = operand.indexOf('?')
  let database: string | undefined

  if (query === -1)
    return undefined

  for (const pair of operand.slice(query + 1).split('&')) {
    const equals = pair.indexOf('=')

    if (equals !== -1 && percentDecoded(pair.slice(0, equals)) === 'dbname')
      database = pair.slice(equals + 1)
  }

  return database
}

function urlDatabase(url: string): string | undefined {
  const raw = queryDatabase(url) ?? URL_PATH.exec(url)?.[1]

  return raw === undefined || raw === '' ? undefined : percentDecoded(raw)
}

// The database a `-d` value or a database operand names: a URL's query `dbname` or path, a conninfo string's last `dbname`, else the word itself.
function databaseOf(operand: string): string | undefined {
  if (URL_START.test(operand)) {
    const whole = urlDatabase(operand)
    const fragment = operand.indexOf('#')

    if (fragment === -1)
      return whole

    // A client that cuts the fragment and one that keeps it may reach two databases, so the URL names a test one only when both readings do.
    const cut = urlDatabase(operand.slice(0, fragment))

    return whole !== undefined && TEST_SCOPED.test(whole) ? cut : whole
  }

  if (!CONNINFO.test(operand))
    return operand

  let database: string | undefined
  let end = 0

  for (const match of operand.matchAll(CONNINFO_PAIR)) {
    const [whole, key, quoted, bare] = match

    end = match.index + whole.length

    if (key === 'dbname')
      database = (quoted ?? bare ?? '').replaceAll(ESCAPED, '$1')
  }

  return operand.slice(end).trim() === '' ? database : UNREAD_CONNINFO
}

// getopt_long and mysql's option parser take a long option cut short to what is unambiguous, `--comm` or `--exec`; it is read as the one option it prefixes.
function fullOption(option: string): string {
  if (KNOWN_LONGS.includes(option) || option.length < 4)
    return option

  const candidates = KNOWN_LONGS.filter(each => each.startsWith(option))

  return candidates.length === 1 ? candidates[0]! : option
}

// Reads a client's words, `-c`, `-tAc STATEMENT`, `--command=...`, `-fFILE`, `--file FILE`, `< FILE`, `<<< 'STATEMENT'` and the database it names included.
function clientInput(name: string, args: readonly string[]): ClientInput {
  const input: ClientInput = { statements: [], files: [], operands: [] }
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
      const [spelled = '', ...rest] = arg.split('=')
      const option = fullOption(spelled)
      const attached = rest.length > 0 ? rest.join('=') : undefined
      const value = attached ?? args[i + 1] ?? ''

      if (STATEMENT_LONGS.has(option))
        input.statements.push(value)
      else if (option === '--file')
        input.files.push(value)
      else if (DATABASE_LONGS.has(option))
        input.database = databaseOf(value)

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
          input.database = databaseOf(value)

        break
      }
    }
    else {
      input.operands.push(arg)
    }
  }

  // the last `-d` wins, and names the database over the first operand, which is then the user
  if (name === 'sqlite3')
    input.statements.push(...input.operands.slice(1))
  else if (input.database === undefined && input.operands[0] !== undefined)
    input.database = databaseOf(input.operands[0])

  return input
}

// Whether the words name a test-only target: what comes before the client (a compose file, an environment, a service) or the database it names; a client's statements and files never count.
function isTestWord(word: string): boolean {
  const assignment = ASSIGNMENT.exec(word)

  if (assignment !== null && !TARGET_VARIABLE.test(assignment[1] ?? ''))
    return false

  return TEST_SCOPED.test(word) || SHOT_STACK.test(word)
}

// The words that can name a target: the value of a user option is the account, not the environment.
function targetWords(words: readonly string[]): string[] {
  return words.filter((word, index) => !USER_OPTION.test(words[index - 1] ?? '') && !USER_ATTACHED.test(word))
}

// A database the client names wins over what a variable picks, `PGDATABASE=x_test psql -d prod` or `APP_ENV=test psql -d prod` connecting to prod.
function isTestScoped(words: readonly string[], client: number, input: ClientInput | null): boolean {
  if (client === -1)
    return targetWords(words).some(isTestWord)

  const named = input?.database
  const before = targetWords(words.slice(0, client)).filter(word => named === undefined || !ASSIGNMENT.test(word))

  return before.some(isTestWord) || (named !== undefined && TEST_SCOPED.test(named))
}

// Whether a piece runs a SQL client, anywhere in its words so `docker compose exec db psql` counts.
export function runsSqlClient(command: string): boolean {
  return splitCommand(command).some(piece => tokenize(piece.command).some(word => SQL_CLIENTS.has(programOf(word))))
}

// The text of a file a client reads, null when it cannot be: a device or a missing file.
async function fileText(path: string, read: (path: string) => Promise<string | null>): Promise<string | null> {
  return DEVICE_PATH.test(path) ? null : read(path)
}

// The SQL a client speaks, none for sqlite3, whose database is its file.
function clientDialect(name: string): Dialect | undefined {
  if (IS_MYSQL.has(name))
    return 'mysql'

  return name === 'sqlite3' ? undefined : 'postgres'
}

// The statements a client is given: its own options, its heredoc body, the files it reads and what a printer pipes into it; `unreadable` names the first file that cannot be read.
async function clientStatements(pieces: readonly Piece[], index: number, input: ClientInput, read: (path: string) => Promise<string | null>): Promise<{ statements: string[], unreadable: string | undefined }> {
  const before = index === 0 ? null : parseCommand(pieces[index - 1]?.command ?? '')
  const isPiped = pieces[index - 1]?.separator === '|'
  // a file the client reads from stdin is its heredoc or what is piped in, not a path
  const paths = input.files.filter(path => !STDIN_PATHS.has(path))
  const files = [...paths, ...(isPiped && before?.program === 'cat' ? before.args.filter(arg => !arg.startsWith('-')) : [])]
  const texts = await Promise.all(files.map(async path => fileText(path, read)))
  const unreadable = texts.indexOf(null)
  const statements = [
    ...input.statements,
    ...(pieces[index]?.heredocs ?? []),
    isPiped && before !== null && PRINTERS.has(before.program) ? before.args.join(' ') : '',
    ...texts.map(text => text ?? ''),
  ]

  return { statements, unreadable: unreadable === -1 ? undefined : files[unreadable] }
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

    if (inShotStack)
      continue

    if (isTestScoped(words, client, input)) {
      // what a test database is fed may still write to another one, which db refuses too; a file that cannot be read is no statement here
      const dialect = clientDialect(programOf(words[client] ?? ''))

      if (input !== null && dialect !== undefined) {
        const { statements } = await clientStatements(pieces, index, input, read)

        if (statements.some(statement => hasWrite(statement) && otherDatabases(statement, dialect, input.database ?? '').length > 0))
          return SQL_OTHER_DATABASE
      }

      continue
    }

    if (WRITING_TOOLS.has(program) && !words.some(word => LIST_OPTIONS.has(word)))
      return SQL_WRITE

    if (CONSOLE_PROGRAMS.has(program) && words.some(word => WRITING_CONSOLE.test(word)))
      return SQL_WRITE

    if (input === null)
      continue

    const { statements, unreadable } = await clientStatements(pieces, index, input, read)

    if (unreadable !== undefined)
      return sqlUnreadable(unreadable)

    if (statements.some(hasWrite))
      return SQL_WRITE
  }

  return null
}
