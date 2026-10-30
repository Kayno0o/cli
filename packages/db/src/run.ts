import { isIP } from 'node:net'
import process from 'node:process'
import { fail } from '@kaynooo/cli-kit'
import { SQL } from 'bun'
import { DEFAULT_ENV } from './args'
import { composeServices, pickPostgres, serviceUrl } from './compose'
import { scrub } from './mask'

export type Row = Record<string, unknown>

const STATEMENT_TIMEOUT = '30s'
// Doctrine's DATABASE_URL carries these for the ORM, not for the server.
const DOCTRINE_PARAMS = ['serverVersion', 'charset']
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const BRACKETS = /^\[|\]$/g

export interface Target {
  env?: string | undefined
  service?: string | undefined
  database?: string | undefined
}

// Thrown inside the transaction so that Bun rolls it back instead of committing.
class Rollback extends Error {}

// A URL naming a compose service as its host, `postgresql://app:pw@database:5432/app` in a Symfony .env, rewritten to where this machine reaches that service.
async function reachable(value: string): Promise<URL> {
  let url: URL

  try {
    url = new URL(value)
  }
  catch {
    fail('the connection URL does not parse')
  }

  if (url.hostname === '' || LOCAL_HOSTS.has(url.hostname) || isIP(url.hostname.replace(BRACKETS, '')) !== 0)
    return url

  const service = (await composeServices()).find(candidate => candidate.names.includes(url.hostname))

  if (service !== undefined) {
    url.hostname = service.host.includes(':') ? `[${service.host}]` : service.host
    url.port = String(service.port)
  }

  return url
}

// The URL to read: a compose service when one is named, else the environment key (which Bun fills from .env files), else the project's only running Postgres service.
export async function connectionUrl({ env, service, database }: Target): Promise<string> {
  const value = service === undefined ? process.env[env ?? DEFAULT_ENV] : undefined
  let url: URL

  if (value !== undefined && value !== '')
    url = await reachable(value)
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

// Runs one statement in a READ ONLY transaction that is always rolled back, with every error scrubbed of the URL.
export async function readRows(url: string, statement: string, params: unknown[] = []): Promise<Row[]> {
  const sql = new SQL({ url, max: 1, connectionTimeout: 10 })
  let rows: Row[] = []

  try {
    await sql.begin('read only', async (transaction) => {
      await transaction.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
      rows = [...await transaction.unsafe<Row[]>(statement, params)]

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
