import { describe, expect, test } from 'bun:test'
import { isSecretName } from '../src/secrets'

describe('isSecretName', () => {
  test('is true for the spellings of a secret, in any case or style', () => {
    for (const name of ['API_TOKEN', 'client_secret', 'DB_PASSWORD', 'PGPASSWORD', 'DB_PASSWD', 'DB_PASS', 'SMTP_PWD', 'AUTH', 'SALT', 'COOKIE', 'CREDENTIALS', 'STRIPE_KEY', 'apiKey', 'APIKey', 'PRIVATE_PEM', 'SENTRY_DSN', 'session_id', 'ssn', 'iban', 'cvv', 'jwt', 'PGPASS', 'DBPASS', 'pgPass', 'GPG_PASSPHRASE', 'AUTHORIZATION', 'sessionid', 'PHPSESSID', 'connectionString'])
      expect(isSecretName(name)).toBe(true)
  })

  test('is false for names that only contain the letters', () => {
    for (const name of ['PORT', 'compass', 'COMPASS_URL', 'BYPASS_CACHE', 'passenger', 'author', 'keyword', 'created_at', 'footprint', 'hashtag', 'id'])
      expect(isSecretName(name)).toBe(false)
  })
})
