import type { Service } from './compose'
import type { Dialect } from './guard'
import { isIP } from 'node:net'
import process from 'node:process'
import { fail, warn } from '@kaynooo/cli-kit'
import { SQL } from 'bun'
import { DEFAULT_ENV, DEFAULT_TIMEOUT_MS } from './args'
import { composeServices, containerService, pickService, serviceUrl } from './compose'
import { testWriteBlockers } from './guard'
import { scrub } from './mask'
import { loadSettings, settingsPath } from './settings'

export type Row = Record<string, unknown>

// Sent at connect, so the session is bounded (and read-only for a read) before the transaction starts.
const SESSION_SETTINGS = { lock_timeout: '5s', idle_in_transaction_session_timeout: '60s' }
const CURSOR = 'db_rows'
// A cursor can only be declared on these, SHOW and EXPLAIN are read whole.
const CURSOR_STARTS = /^\s*(?:select|with|values|table)\b/i
const TRAILING_SEMICOLONS = /[;\s]+$/
// Doctrine's DATABASE_URL carries these for the ORM, not for the server.
const DOCTRINE_PARAMS = ['serverVersion', 'charset']
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const BRACKETS = /^\[|\]$/g
const POSTGRES_SCHEMES = new Set(['postgres:', 'postgresql:'])
const MYSQL_SCHEMES = new Set(['mysql:', 'mysql2:', 'mariadb:'])
// ER_PARSE_ERROR and ER_DUP_FIELDNAME: what a statement wrapped in a derived table can raise without having raised it bare.
const WRAP_ERRNOS = new Set([1064, 1060])
// MySQL counts max_execution_time in milliseconds, MariaDB max_statement_time in seconds.
const mysqlTimeouts = (ms: number) => [`SET SESSION max_execution_time = ${ms}`, `SET SESSION max_statement_time = ${ms / 1000}`]

// A write only runs on a database whose name ends so.
export const TEST_SUFFIX = '_test'

export interface Target {
  env?: string | undefined
  service?: string | undefined
  container?: string | undefined
  database?: string | undefined
}

// A statement's rows, and how many rows it changed.
export type Result = Row[] & { affected?: number }

export interface Tx {
  unsafe: (statement: string, params?: unknown[]) => Promise<Result>
}

export interface Session {
  // Runs the work in one transaction, rolled back when it throws and committed when it returns.
  transaction: (work: (tx: Tx) => Promise<void>, readOnly: boolean) => Promise<void>
  close: () => Promise<void>
}

// Opens a session on a server; stubbed in tests.
export type Connect = (url: string, dialect: Dialect, readOnly: boolean, timeoutMs?: number) => Session

// Thrown inside the transaction so that Bun rolls it back instead of committing.
class Rollback extends Error {}

export function dialectOf(url: URL): Dialect {
  if (POSTGRES_SCHEMES.has(url.protocol))
    return 'postgres'

  if (MYSQL_SCHEMES.has(url.protocol))
    return 'mysql'

  return fail(`the connection URL is ${url.protocol.replace(':', '')}://, but db reads Postgres (postgres://), MySQL and MariaDB (mysql://, mariadb://) only`)
}

// The host a URL connects to: its authority, else the `host` parameter some drivers take in its place. Empty or a path stands for a local socket.
function hostOf(url: URL): string {
  const host = url.hostname === '' ? url.searchParams.get('host') ?? '' : url.hostname

  return host.replace(BRACKETS, '').toLowerCase()
}

const isLocal = (host: string) => host === '' || host.startsWith('/') || LOCAL_HOSTS.has(host)

// Docker's default bridge networks, 172.16.0.0/12, where a container db reaches a service with nothing published.
const DOCKER_NETWORK = /^172\.(?:1[6-9]|2\d|3[01])\./

// MySQL 8's default login sends the password under the server's RSA key when there is no TLS: fetching that key is only safe where nobody sits on the path, this machine or its docker networks.
export function allowsKeyRetrieval(url: string): boolean {
  try {
    const host = hostOf(new URL(url))

    return isLocal(host) || (isIP(host) !== 0 && DOCKER_NETWORK.test(host))
  }
  catch {
    return false
  }
}

// The compose service a hostname names: the service called so, else the only service of the URL's engine answering to it on a network.
function serviceNamed(services: Service[], host: string, dialect: Dialect): Service | undefined {
  const exact = services.find(candidate => candidate.name.toLowerCase() === host)

  if (exact !== undefined)
    return exact

  const engine = dialect === 'mysql' ? 'mysql' : 'postgres'
  const aliased = services.filter(candidate => candidate.engine === engine && candidate.names.some(name => name.toLowerCase() === host))

  if (aliased.length > 1)
    fail(`${host} names several services (${aliased.map(candidate => candidate.name).join(', ')}): pick one with --service`)

  return aliased[0]
}

// A URL naming a compose service as its host, `postgresql://app:pw@database:5432/app` in a Symfony .env, rewritten to where this machine reaches that service. Any other host that is not local must be in the allowlist of ~/.config/kaynooo-cli/db.json.
export async function reachable(value: string, home?: string): Promise<URL> {
  let url: URL

  try {
    url = new URL(value)
  }
  catch {
    fail('the connection URL does not parse')
  }

  const dialect = dialectOf(url)
  const host = hostOf(url)

  if (isLocal(host))
    return url

  const service = isIP(host) === 0 ? serviceNamed(await composeServices(), host, dialect) : undefined

  if (service !== undefined) {
    url.hostname = service.host.includes(':') ? `[${service.host}]` : service.host
    url.port = String(service.port)

    return url
  }

  if (!((await loadSettings(home)).allowedHosts ?? []).some(allowed => allowed.toLowerCase().replace(BRACKETS, '') === host))
    fail(`${host} is neither local nor a compose service, so db does not connect to it: list it in "allowedHosts" in ${settingsPath(home)} to allow it`)

  return url
}

// The URL to read: a container or compose service when one is named, else the environment key (which Bun fills from .env files), else the project's only running database service.
export async function connectionUrl({ env, service, container, database }: Target, home?: string): Promise<string> {
  if (service !== undefined && container !== undefined)
    fail('--service and --container name two databases: pick one')

  const isNamed = service !== undefined || container !== undefined
  const value = isNamed ? undefined : process.env[env ?? DEFAULT_ENV]
  let url: URL

  if (value !== undefined && value !== '')
    url = await reachable(value, home)
  else if (env !== undefined && !isNamed)
    fail(`${env} is not set: put the connection URL in a .env file or the environment`)
  else
    url = new URL(serviceUrl(container === undefined ? pickService(await composeServices(), service) : await containerService(container)))

  for (const param of DOCTRINE_PARAMS)
    url.searchParams.delete(param)

  if (database !== undefined)
    url.pathname = `/${database}`

  return url.href
}

// The database a URL opens, empty when it names none.
export function databaseOfUrl(url: string): string {
  const { pathname } = new URL(url)

  try {
    return decodeURIComponent(pathname.slice(1))
  }
  catch {
    return pathname.slice(1)
  }
}

function toResult(rows: Row[] & { count?: number, affectedRows?: number }): Result {
  return Object.assign([...rows], { affected: rows.count ?? rows.affectedRows ?? rows.length })
}

// The Bun SQL client, which speaks Postgres and MySQL alike. A read session is read-only from the start: Postgres by `default_transaction_read_only` at connect and a READ ONLY transaction, MySQL by `START TRANSACTION READ ONLY` on a reserved connection.
export const bunConnect: Connect = (url, dialect, readOnly, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const sql = new SQL({ url, max: 1, connectionTimeout: 10, ...dialect === 'postgres' ? { connection: { ...SESSION_SETTINGS, ...readOnly ? { default_transaction_read_only: 'on' } : {} } } : { allowPublicKeyRetrieval: allowsKeyRetrieval(url) } })

  return {
    async transaction(work, isReadOnly) {
      if (dialect === 'postgres') {
        const body = async (tx: SQL) => {
          await tx.unsafe(`SET LOCAL statement_timeout = '${timeoutMs}ms'`)
          await work({ unsafe: async (statement, params) => toResult(await tx.unsafe<Row[]>(statement, params)) })
        }

        await (isReadOnly ? sql.begin('read only', body) : sql.begin(body))

        return
      }

      // One reserved connection carries the settings and the transaction, so a reconnect cannot drop the read-only mode in between.
      const connection = await sql.reserve()

      try {
        await mysqlTransaction({ unsafe: async (statement, params) => connection.unsafe<Row[]>(statement, params) }, work, isReadOnly, timeoutMs)
      }
      finally {
        await connection.release()
      }
    },
    async close() {
      await sql.close()
    },
  }
}

// Runs the work in a transaction on one MySQL connection: `START TRANSACTION READ ONLY` is the read-only mode itself, sent on the very connection that runs the statement.
export async function mysqlTransaction(connection: { unsafe: (statement: string, params?: unknown[]) => Promise<Row[]> }, work: (tx: Tx) => Promise<void>, readOnly: boolean, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  for (const timeout of mysqlTimeouts(timeoutMs)) {
    try {
      await connection.unsafe(timeout)
    }
    catch {
      // MySQL and MariaDB name this setting differently, so the other server refuses one of the two.
    }
  }

  await connection.unsafe(readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION')

  try {
    await work({ unsafe: async (statement, params) => toResult(await connection.unsafe(statement, params)) })
  }
  catch (error) {
    try {
      await connection.unsafe('ROLLBACK')
    }
    catch {
      // The connection is gone, which rolls the transaction back as well.
    }

    throw error
  }

  await connection.unsafe('COMMIT')
}

const isWrapError = (error: unknown) => error instanceof Error && WRAP_ERRNOS.has((error as Error & { errno?: number }).errno ?? 0)

// MySQL has no cursor to declare, so a select is wrapped to stop at limit + 1 rows, and read whole when the wrapping itself is refused (a parse error, or two columns of one name); any other error, a timeout or a lost connection, is the statement's own.
async function fetchRows(tx: Tx, dialect: Dialect, statement: string, params: unknown[], limit: number | undefined): Promise<Row[]> {
  if (limit === undefined || !CURSOR_STARTS.test(statement))
    return tx.unsafe(statement, params)

  if (dialect === 'postgres') {
    await tx.unsafe(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${statement}`, params)

    return tx.unsafe(`FETCH FORWARD ${limit + 1} FROM ${CURSOR}`)
  }

  try {
    return await tx.unsafe(`select * from (\n${statement.replace(TRAILING_SEMICOLONS, '')}\n) as ${CURSOR} limit ${limit + 1}`, params)
  }
  catch (error) {
    if (!isWrapError(error))
      throw error

    return tx.unsafe(statement, params)
  }
}

function messageOf(error: unknown, url: string): string {
  return scrub(error instanceof Error ? error.message : String(error), url)
}

// Runs one statement in a READ ONLY transaction that is always rolled back, with every error scrubbed of the URL. With a limit, a select is read through a cursor that stops at limit + 1 rows, enough to tell that more were left.
export async function readRows(url: string, statement: string, params: unknown[] = [], limit?: number, connect: Connect = bunConnect, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Row[]> {
  const dialect = dialectOf(new URL(url))
  const session = connect(url, dialect, true, timeoutMs)
  let rows: Row[] = []

  try {
    await session.transaction(async (tx) => {
      rows = [...await fetchRows(tx, dialect, statement, params, limit)]

      throw new Rollback()
    }, true)
  }
  catch (error) {
    if (!(error instanceof Rollback))
      fail(messageOf(error, url), 1)
  }
  finally {
    await closeQuietly(session, url)
  }

  return rows
}

export type WriteResult = { isRun: true, database: string, rows: Row[], affected: number } | { isRun: false, reasons: string[] }

// What stops a write on this database, empty when it may run: its name must end in `_test` and the statement must not reach past it.
function testWriteReasons(database: string, statement: string, dialect: Dialect): string[] {
  if (!database.endsWith(TEST_SUFFIX))
    return [`the database ${database === '' ? 'is not named' : database} does not end in ${TEST_SUFFIX}`]

  return testWriteBlockers(statement, dialect, database)
}

// Runs a write in a transaction that commits, only when the database actually connected to ends in `_test`: the URL's name is checked before connecting, then the server is asked which database the session is on, so the statement's own text never decides it.
export async function writeRows(url: string, statement: string, connect: Connect = bunConnect): Promise<WriteResult> {
  const dialect = dialectOf(new URL(url))
  const declared = testWriteReasons(databaseOfUrl(url), statement, dialect)

  if (declared.length > 0)
    return { isRun: false, reasons: declared }

  const session = connect(url, dialect, false)
  let outcome: WriteResult = { isRun: false, reasons: ['not run'] }

  try {
    await session.transaction(async (tx) => {
      const [current] = await tx.unsafe(dialect === 'postgres' ? 'select current_database() as name' : 'select database() as name')
      const database = String(current?.name ?? '')
      const reasons = testWriteReasons(database, statement, dialect)

      if (reasons.length > 0) {
        outcome = { isRun: false, reasons }

        throw new Rollback()
      }

      const result = await tx.unsafe(statement)

      outcome = { isRun: true, database, rows: [...result], affected: result.affected ?? 0 }
    }, false)
  }
  catch (error) {
    if (!(error instanceof Rollback))
      fail(messageOf(error, url), 1)
  }
  finally {
    await closeQuietly(session, url)
  }

  return outcome
}

async function closeQuietly(session: Session, url: string): Promise<void> {
  try {
    await session.close()
  }
  catch (error) {
    warn(messageOf(error, url))
  }
}
