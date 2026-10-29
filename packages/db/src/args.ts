export const DEFAULT_ENV = 'DATABASE_URL'
export const DEFAULT_LIMIT = 100

export const connectionOptions = {
  env: { type: 'string', short: 'e', description: `environment key holding the connection URL (${DEFAULT_ENV})` },
} as const

export const outputOptions = {
  limit: { type: 'string', short: 'n', description: `rows shown (${DEFAULT_LIMIT})` },
  raw: { type: 'boolean', description: 'show columns masked by default (emails, phones, tokens, password hashes)' },
  json: { type: 'boolean', description: 'print JSON' },
} as const
