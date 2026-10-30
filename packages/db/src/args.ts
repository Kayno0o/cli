export const DEFAULT_ENV = 'DATABASE_URL'
export const DEFAULT_LIMIT = 100

export const connectionOptions = {
  env: { type: 'string', short: 'e', description: `environment key holding the connection URL (${DEFAULT_ENV}), a compose service's host in it reached from here` },
  service: { type: 'string', short: 's', description: 'read the running Postgres service of this name in the compose project, credentials from its environment' },
  database: { type: 'string', short: 'd', description: 'database to read instead of the URL\'s or the service\'s' },
} as const

export const outputOptions = {
  limit: { type: 'string', short: 'n', description: `rows shown (${DEFAULT_LIMIT})` },
  raw: { type: 'boolean', description: 'show columns masked by default (emails, phones, tokens, password hashes)' },
  json: { type: 'boolean', description: 'print JSON' },
} as const
