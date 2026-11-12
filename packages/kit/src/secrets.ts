// Parts of a name that make it secret wherever they sit in it (`DB_PASSWORD`, `PGPASSWORD`, `clientSecret`).
const SECRET_PART = /token|secret|passw|passphrase|credential|private|dsn|apikey|accesskey|authorization|sess(?:ion)?id|connectionstring|key$/i
// Whole words of a name that make it secret (`DB_PASS`, `SMTP_PWD`, `encryptionKey`, `session_id`), so `author` or `keyword` stay plain.
const SECRET_WORDS = new Set(['key', 'pass', 'pwd', 'auth', 'salt', 'cookie', 'session', 'jwt', 'ssn', 'iban', 'card', 'cvv', 'otp'])
const WORD_BREAKS = /[^a-zA-Z\d]+|(?<=[a-z\d])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/
// Words ending in `pass` that hold none (`PGPASS` and `DBPASS` do).
const NOT_PASSWORDS = new Set(['compass', 'encompass', 'bypass', 'overpass', 'underpass', 'surpass', 'trespass'])

function isSecretWord(word: string): boolean {
  const lower = word.toLowerCase()

  return SECRET_WORDS.has(lower) || (lower.endsWith('pass') && !NOT_PASSWORDS.has(lower))
}

// True for the name of a variable, a column or a JSON key that holds a secret, by one definition shared by ev and db.
export function isSecretName(name: string): boolean {
  return SECRET_PART.test(name) || name.split(WORD_BREAKS).some(isSecretWord)
}
