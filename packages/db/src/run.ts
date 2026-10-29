import process from 'node:process'
import { fail } from '@kaynooo/cli-kit'
import { SQL } from 'bun'
import { scrub } from './mask'

export type Row = Record<string, unknown>

const STATEMENT_TIMEOUT = '30s'

// Thrown inside the transaction so that Bun rolls it back instead of committing.
class Rollback extends Error {}

// The connection URL named by an environment key, which Bun fills from .env files.
export function connectionUrl(key: string): string {
  const url = process.env[key]

  if (url === undefined || url === '')
    fail(`${key} is not set: put the connection URL in a .env file or the environment, or name another key with --env`)

  return url
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
