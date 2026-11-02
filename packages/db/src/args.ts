import { jsonOption } from '@kaynooo/cli-kit'

export const DEFAULT_ENV = 'DATABASE_URL'
export const DEFAULT_LIMIT = 100

export const HOSTS_NOTE = 'db connects to a local host (localhost, 127.0.0.1, ::1) or a compose service only: any other host is refused (exit 2) unless it is listed under "allowedHosts" in ~/.config/db/config.json.'

export const WRITE_NOTE = 'A write runs only when the database actually connected to has a name ending in _test (checked on the server, and a statement that names another database, or uses USE, SET, files or server objects, is not run); any other write is printed for you to run.'

export const connectionOptions = {
  env: { type: 'string', short: 'e', description: `environment key holding the connection URL (${DEFAULT_ENV}, postgres:// or mysql://), a compose service's host in it reached from here` },
  service: { type: 'string', short: 's', description: 'read the running Postgres, MySQL or MariaDB service of this name in the compose project, credentials from its environment' },
  container: { type: 'string', short: 'c', description: 'read the running Postgres, MySQL or MariaDB container of this name, in any compose project or none, credentials from its environment' },
  database: { type: 'string', short: 'd', description: 'database to read instead of the URL\'s or the service\'s' },
} as const

export const outputOptions = {
  limit: { type: 'string', short: 'n', description: `rows shown (${DEFAULT_LIMIT})` },
  raw: { type: 'boolean', description: 'show columns masked by default (emails, phones, tokens, password hashes, secret-named keys inside JSON values)' },
  json: jsonOption(),
} as const
