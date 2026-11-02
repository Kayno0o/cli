import type { Service } from './compose'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import process from 'node:process'
import { fail } from '@kaynooo/cli-kit'
import { SQL } from 'bun'
import { DEFAULT_ENV } from './args'
import { composeServices, pickPostgres, serviceUrl } from './compose'
import { scrub } from './mask'
import { loadSettings, settingsPath } from './settings'

export type Row = Record<string, unknown>

const STATEMENT_TIMEOUT = '30s'
// Sent at connect, so the session is read-only and bounded before the transaction starts.
const SESSION_SETTINGS = { default_transaction_read_only: 'on', lock_timeout: '5s', idle_in_transaction_session_timeout: '60s' }
const CURSOR = 'db_rows'
// A cursor can only be declared on these, SHOW and EXPLAIN are read whole.
const CURSOR_STARTS = /^\s*(?:select|with|values|table)\b/i
// Doctrine's DATABASE_URL carries these for the ORM, not for the server.
const DOCTRINE_PARAMS = ['serverVersion', 'charset']
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const BRACKETS = /^\[|\]$/g

export interface Target {
  env?: string | undefined
  service?: string | undefined
  database?: string | undefined
}

// Thrown inside the transaction so that Bun rolls it back instead of committing.
class Rollback extends Error {}

// The host a URL connects to: its authority, else the `host` parameter some drivers take in its place. Empty or a path stands for a local socket.
function hostOf(url: URL): string {
  const host = url.hostname === '' ? url.searchParams.get('host') ?? '' : url.hostname

  return host.replace(BRACKETS, '').toLowerCase()
}

const isLocal = (host: string) => host === '' || host.startsWith('/') || LOCAL_HOSTS.has(host)

// The compose service a hostname names: the service called so, else the only Postgres service answering to it on a network.
function serviceNamed(services: Service[], host: string): Service | undefined {
  const exact = services.find(candidate => candidate.name.toLowerCase() === host)

  if (exact !== undefined)
    return exact

  const aliased = services.filter(candidate => candidate.engine === 'postgres' && candidate.names.some(name => name.toLowerCase() === host))

  if (aliased.length > 1)
    fail(`${host} names several services (${aliased.map(candidate => candidate.name).join(', ')}): pick one with --service`)

  return aliased[0]
}

// A URL naming a compose service as its host, `postgresql://app:pw@database:5432/app` in a Symfony .env, rewritten to where this machine reaches that service. Any other host that is not local must be in the allowlist of ~/.config/db/config.json.
export async function reachable(value: string, home = homedir()): Promise<URL> {
  let url: URL

  try {
    url = new URL(value)
  }
  catch {
    fail('the connection URL does not parse')
  }

  const host = hostOf(url)

  if (isLocal(host))
    return url

  const service = isIP(host) === 0 ? serviceNamed(await composeServices(), host) : undefined

  if (service !== undefined) {
    url.hostname = service.host.includes(':') ? `[${service.host}]` : service.host
    url.port = String(service.port)

    return url
  }

  if (!((await loadSettings(home)).allowedHosts ?? []).some(allowed => allowed.toLowerCase().replace(BRACKETS, '') === host))
    fail(`${host} is neither local nor a compose service, so db does not connect to it: list it in "allowedHosts" in ${settingsPath(home)} to allow it`)

  return url
}

// The URL to read: a compose service when one is named, else the environment key (which Bun fills from .env files), else the project's only running Postgres service.
export async function connectionUrl({ env, service, database }: Target, home = homedir()): Promise<string> {
  const value = service === undefined ? process.env[env ?? DEFAULT_ENV] : undefined
  let url: URL

  if (value !== undefined && value !== '')
    url = await reachable(value, home)
  else if (env !== undefined && service === undefined)
    fail(`${env} is not set: put the connection URL in a .env file or the environment`)
  else
    url = new URL(serviceUrl(pickPostgres(await composeServices(), service)))

  for (const param of DOCTRINE_PARAMS)
    url.searchParams.delete(param)

  if (database !== undefined)
    url.pathname = `/${database}`

  return url.href
}

// Runs one statement in a READ ONLY transaction that is always rolled back, with every error scrubbed of the URL. With a limit, a select is read through a cursor that stops at limit + 1 rows, enough to tell that more were left.
export async function readRows(url: string, statement: string, params: unknown[] = [], limit?: number): Promise<Row[]> {
  const sql = new SQL({ url, max: 1, connectionTimeout: 10, connection: SESSION_SETTINGS })
  let rows: Row[] = []

  try {
    await sql.begin('read only', async (transaction) => {
      await transaction.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)

      if (limit !== undefined && CURSOR_STARTS.test(statement)) {
        await transaction.unsafe(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${statement}`, params)
        rows = [...await transaction.unsafe<Row[]>(`FETCH FORWARD ${limit + 1} FROM ${CURSOR}`)]
      }
      else {
        rows = [...await transaction.unsafe<Row[]>(statement, params)]
      }

      throw new Rollback()
    })
  }
  catch (error) {
    if (!(error instanceof Rollback))
      fail(scrub(error instanceof Error ? error.message : String(error), url), 1)
  }
  finally {
    await closeQuietly(sql, url)
  }

  return rows
}

async function closeQuietly(sql: SQL, url: string): Promise<void> {
  try {
    await sql.close()
  }
  catch (error) {
    console.error(scrub(error instanceof Error ? error.message : String(error), url))
  }
}
