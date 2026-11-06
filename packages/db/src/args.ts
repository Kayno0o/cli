import type { ExitRow } from '@kaynooo/cli-kit'
import { jsonOption, wholeNumber } from '@kaynooo/cli-kit'

export const DEFAULT_ENV = 'DATABASE_URL'
export const DEFAULT_LIMIT = 20
// What --all shows: the cap before the default was lowered.
export const ALL_LIMIT = 100

// The exit code of a statement handed back instead of run: it would write.
export const WRITE_EXIT = 1

export const EXITS: ExitRow[] = [[0, 'it ran'], [1, 'the database refused it, was unreachable, or the statement would write and was not run'], [2, 'a usage error or a host that is not allowed']]

export const HOSTS_NOTE = 'db connects to a local host (localhost, 127.0.0.1, ::1) or a compose service only: any other host is refused (exit 2) unless it is listed under "allowedHosts" in ~/.config/kaynooo-cli/db.json.'

export const WRITE_NOTE = 'A write runs only when the database actually connected to has a name ending in _test (checked on the server, and a statement that names another database, or uses USE, SET, files or server objects, is not run); any other write is printed for you to run.'

export const connectionOptions = {
  env: { type: 'string', short: 'e', description: `environment key holding the connection URL (${DEFAULT_ENV}, postgres:// or mysql://), a compose service's host in it reached from here` },
  service: { type: 'string', short: 's', description: 'read the running Postgres, MySQL or MariaDB service of this name in the compose project, credentials from its environment' },
  container: { type: 'string', short: 'c', description: 'read the running Postgres, MySQL or MariaDB container of this name, in any compose project or none, credentials from its environment' },
  database: { type: 'string', short: 'd', description: 'database to read instead of the URL\'s or the service\'s' },
} as const

// The rows flag every listing words alike (-n), --limit being the name it had before.
const rows = { type: 'string', short: 'n', aliases: ['limit'], description: `show at most this many rows, the rest counted (${DEFAULT_LIMIT}), 0 for none` } as const
const all = { type: 'boolean', description: `show up to ${ALL_LIMIT} rows, the cap before the default was lowered to ${DEFAULT_LIMIT} (-n goes higher)`, conflicts: ['rows'] } as const

// The cap a listing shows: --all, else -n, else the fallback.
export function rowLimit(values: { rows?: string | undefined, all?: boolean | undefined }, fallback = DEFAULT_LIMIT): number {
  return values.all === true ? ALL_LIMIT : wholeNumber(values.rows, 'rows', fallback, 0)
}

// The catalog commands list names, types and sizes: no column of theirs is masked, so there is no --raw.
export const catalogOptions = {
  rows,
  all,
  json: jsonOption(),
} as const

export const outputOptions = {
  rows,
  all,
  raw: { type: 'boolean', description: 'show columns masked by default (emails, phones, tokens, password hashes, secret-named keys inside JSON values)' },
  json: jsonOption(),
} as const
