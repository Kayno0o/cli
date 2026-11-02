export interface Token {
  // A quoted identifier is its unescaped content, kept apart from keywords: `"set"` is a name while `set` is a command.
  kind: 'word' | 'punct' | 'quoted'
  text: string
}

export interface Verdict {
  // Why the SQL cannot be trusted to only read, empty when it can.
  reasons: string[]
  statements: number
}

const WORD_START = /[a-z_]/i
const WORD_PART = /[\w$]/
const SPACE = /\s/
const ESCAPE_PREFIX = /e/i
const DOLLAR_TAG = /^\$(?:[a-z_]\w*)?\$/i
const LOCK_KIND = /^(?:update|share|no|key)$/
const DIGITS = /\d/
const COMMAND_ENDS = ';'
// Stands for a quote or dollar-quoted body that never closes, which hides the rest of the text.
const UNCLOSED = 'unclosed'
// Stand for a NUL byte, and for a `U&"..."` identifier whose escapes can spell any name.
const NUL = '\0'
const UNICODE_IDENTIFIER = 'U&"'
const UNICODE_PREFIX = /u&$/i
const LINE_END = /[\r\n]/

// A SET starting a statement changes a session setting, harmless unless it switches the role or the transaction's access mode.
const PRIVILEGED_SET = new Set(['role', 'session', 'transaction'])

// Statements that may start a read.
const READ_STARTS = new Set(['select', 'with', 'values', 'table', 'show', 'explain'])

// Words that write or lock wherever they appear in a statement that started like a read, such as a DELETE inside a CTE.
const WRITE_WORDS = new Set(['insert', 'update', 'delete', 'merge', 'truncate', 'drop', 'alter', 'create', 'grant', 'revoke', 'into', 'call', 'vacuum', 'lock', 'refresh', 'reindex', 'cluster', 'do'])

// Functions with side effects: sequences, settings, backends, advisory locks, large objects, remote access, server files, sleeping and transaction ids.
const SIDE_EFFECT_FUNCTIONS = /^(?:nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_restore_point|pg_advisory_lock\w*|pg_advisory_xact_lock\w*|pg_try_advisory\w*|pg_notify|lo_\w+|dblink\w*|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|pg_sleep\w*|pg_export_snapshot|pg_backup_start|pg_backup_stop|pg_start_backup|pg_stop_backup|txid_current|pg_current_xact_id|pg_current_logfile|pg_wal_replay_\w+|\w+_to_xml\w*|pg_logical_\w+|pg_replication_\w+|pg_drop_replication_slot|pg_stat_reset\w*|pg_promote|pg_file_\w+)$/

// Splits SQL into words and punctuation, dropping comments and the content of strings, quoted identifiers and dollar-quoted bodies, but keeping what a MySQL `/*! ... */` comment runs.
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let at = 0

  while (at < sql.length) {
    const char = sql.charAt(at)
    const next = sql.charAt(at + 1)

    if (SPACE.test(char)) {
      at++
    }
    else if (char === NUL) {
      tokens.push({ kind: 'punct', text: NUL })
      at++
    }
    else if (char === '-' && next === '-') {
      const end = sql.slice(at).search(LINE_END)

      at = end === -1 ? sql.length : at + end + 1
    }
    else if (char === '/' && next === '*' && sql.charAt(at + 2) === '!') {
      at += 3

      while (DIGITS.test(sql.charAt(at)))
        at++
    }
    else if (char === '/' && next === '*') {
      at = skipComment(sql, at)
    }
    else if (char === '\'') {
      const backslashes = ESCAPE_PREFIX.test(sql.charAt(at - 1)) && !WORD_PART.test(sql.charAt(at - 2))
      const end = skipQuoted(sql, at, char, backslashes)

      at = end ?? sql.length
      tokens.push({ kind: 'punct', text: end === undefined ? UNCLOSED : char })
    }
    // A backtick quotes an identifier in MySQL, which clients.ts also checks with this tokenizer.
    else if (char === '"' || char === '`') {
      const end = skipQuoted(sql, at, char, false)

      if (char === '"' && UNICODE_PREFIX.test(sql.slice(Math.max(0, at - 2), at)) && !WORD_PART.test(sql.charAt(at - 3)))
        tokens.push({ kind: 'punct', text: UNICODE_IDENTIFIER })

      tokens.push(end === undefined ? { kind: 'punct', text: UNCLOSED } : { kind: 'quoted', text: sql.slice(at + 1, end - 1).replaceAll(char + char, char) })
      at = end ?? sql.length
    }
    else if (char === '$' && DOLLAR_TAG.test(sql.slice(at))) {
      const tag = DOLLAR_TAG.exec(sql.slice(at))?.[0] ?? '$$'
      const end = sql.indexOf(tag, at + tag.length)

      at = end === -1 ? sql.length : end + tag.length
      tokens.push({ kind: 'punct', text: end === -1 ? UNCLOSED : '$' })
    }
    else if (WORD_START.test(char)) {
      let end = at + 1

      while (end < sql.length && WORD_PART.test(sql.charAt(end)))
        end++

      tokens.push({ kind: 'word', text: sql.slice(at, end).toLowerCase() })
      at = end
    }
    else {
      tokens.push({ kind: 'punct', text: char })
      at++
    }
  }

  return tokens
}

// Index just past a block comment, which Postgres lets nest.
function skipComment(sql: string, start: number): number {
  let depth = 0
  let at = start

  while (at < sql.length) {
    if (sql.startsWith('/*', at)) {
      depth++
      at += 2
    }
    else if (sql.startsWith('*/', at)) {
      depth--
      at += 2

      if (depth === 0)
        return at
    }
    else {
      at++
    }
  }

  return sql.length
}

// Index just past the closing quote, where a doubled quote is an escaped one; undefined when it never closes.
function skipQuoted(sql: string, start: number, quote: string, backslashes: boolean): number | undefined {
  let at = start + 1

  while (at < sql.length) {
    const char = sql.charAt(at)

    if (backslashes && char === '\\') {
      at += 2
    }
    else if (char === quote) {
      if (sql.charAt(at + 1) !== quote)
        return at + 1

      at += 2
    }
    else {
      at++
    }
  }

  return undefined
}

export function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [[]]

  for (const token of tokens) {
    if (token.kind === 'punct' && token.text === COMMAND_ENDS)
      statements.push([])
    else
      statements.at(-1)?.push(token)
  }

  return statements.filter(statement => statement.length > 0)
}

const isPunct = (token: Token | undefined, text: string) => token?.kind === 'punct' && token.text === text

// COPY ... TO STDOUT, or psql's \copy ... TO, only reads: the direction is the first FROM or TO outside parentheses.
function copyReads(statement: Token[], index: number): boolean {
  let depth = 0

  for (const [at, token] of statement.entries()) {
    if (at <= index)
      continue

    if (isPunct(token, '('))
      depth++
    else if (isPunct(token, ')'))
      depth--
    else if (depth === 0 && token.kind === 'word' && (token.text === 'from' || token.text === 'to'))
      return token.text === 'to' && (statement[at + 1]?.text === 'stdout' || isPunct(statement[index - 1], '\\'))
  }

  return false
}

function statementWrites(statement: Token[]): string[] {
  const first = statement[0]
  // psql's meta-commands start with a backslash, `\set` or `\copy`.
  const start = isPunct(first, '\\') ? 1 : 0
  const reasons: string[] = []

  for (const [index, token] of statement.entries()) {
    if (isPunct(token, UNCLOSED))
      reasons.push('has a quote that never closes')
    else if (isPunct(token, NUL))
      reasons.push('contains a NUL byte')
    else if (isPunct(token, UNICODE_IDENTIFIER))
      reasons.push('uses a U& escaped identifier')

    if (token.kind === 'quoted' && SIDE_EFFECT_FUNCTIONS.test(token.text))
      reasons.push(`calls ${token.text}`)

    if (token.kind !== 'word')
      continue

    if (SIDE_EFFECT_FUNCTIONS.test(token.text)) {
      reasons.push(`calls ${token.text}`)
    }
    // Past a dot a keyword is a column or table name, `u.lock`, while a function stays one, `pg_catalog.setval`.
    else if (isPunct(statement[index - 1], '.')) {
      continue
    }
    else if (token.text === 'set') {
      if (index !== start || PRIVILEGED_SET.has(statement[index + 1]?.text ?? ''))
        reasons.push('uses SET')
    }
    else if (token.text === 'copy') {
      if (!copyReads(statement, index))
        reasons.push('uses COPY')
    }
    else if (WRITE_WORDS.has(token.text)) {
      reasons.push(`uses ${token.text.toUpperCase()}`)
    }
    else if (token.text === 'analyze' && first?.text !== 'explain') {
      reasons.push('uses ANALYZE')
    }
    else if (token.text === 'for' && LOCK_KIND.test(statement[index + 1]?.text ?? '')) {
      reasons.push('takes row locks with FOR UPDATE or SHARE')
    }
    else if (token.text === 'comment' && statement[index + 1]?.text === 'on') {
      reasons.push('uses COMMENT ON')
    }
  }

  return reasons
}

// What in the SQL writes, locks or has a side effect, without asking every statement to start like a read: `\dt` or `describe t` pass, a DELETE inside a CTE does not.
export function writes(sql: string): string[] {
  return [...new Set(splitStatements(tokenize(sql)).flatMap(statementWrites))]
}

// Judges SQL before it runs: anything not plainly a read comes back with the reasons.
export function inspect(sql: string): Verdict {
  const statements = splitStatements(tokenize(sql))
  const reasons: string[] = []

  for (const statement of statements) {
    const first = statement[0]

    if (first?.kind !== 'word' || !READ_STARTS.has(first.text))
      reasons.push(`starts with ${first?.text ?? 'nothing'}, not a read`)

    reasons.push(...statementWrites(statement))
  }

  return { reasons: [...new Set(reasons)], statements: statements.length }
}
