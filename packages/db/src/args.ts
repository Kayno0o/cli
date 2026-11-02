import { jsonOption } from '@kaynooo/cli-kit'

export const DEFAULT_ENV = 'DATABASE_URL'
export const DEFAULT_LIMIT = 100

export const HOSTS_NOTE = 'db connects to a local host (localhost, 127.0.0.1, ::1) or a compose service only: any other host is refused (exit 2) unless it is listed under "allowedHosts" in ~/.config/db/config.json.'

export const connectionOptions = {
  env: { type: 'string', short: 'e', description: `environment key holding the connection URL (${DEFAULT_ENV}), a compose service's host in it reached from here` },
  service: { type: 'string', short: 's', description: 'read the running Postgres service of this name in the compose project, credentials from its environment' },
  database: { type: 'string', short: 'd', description: 'database to read instead of the URL\'s or the service\'s' },
} as const

export const outputOptions = {
  limit: { type: 'string', short: 'n', description: `rows shown (${DEFAULT_LIMIT})` },
  raw: { type: 'boolean', description: 'show columns masked by default (emails, phones, tokens, password hashes)' },
  json: jsonOption(),
} as const
