// The SQL a server reads: the two differ in comments, string escapes and quoting, which decides what hides behind a quote.
export type Dialect = 'postgres' | 'mysql'

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

// A name may hold any non-ASCII character in MySQL and Postgres, so one belongs to a word and never stands as punctuation.
const WORD_START = /[a-z_\P{ASCII}]/iu
const WORD_PART = /[\w$\P{ASCII}]/u
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

// A SET starting a statement changes a session setting, harmless unless it switches the role or the transaction's access mode, or in MySQL changes the server (`SET GLOBAL`, `SET PERSIST`, `SET PASSWORD`).
const PRIVILEGED_SET = new Set(['role', 'session', 'transaction', 'global', 'persist', 'persist_only', 'password', 'default'])

// Statements that may start a read.
const READ_STARTS = new Set(['select', 'with', 'values', 'table', 'show', 'explain', 'describe', 'desc'])

// Statements that write, change the server or hide what they run (a prepared statement's text is a string), whatever follows; elsewhere these words are common column names.
const WRITING_STARTS = new Set(['replace', 'load', 'rename', 'flush', 'kill', 'shutdown', 'install', 'uninstall', 'purge', 'optimize', 'repair', 'import', 'prepare', 'execute'])

// Words that write or lock wherever they appear in a statement that started like a read, such as a DELETE inside a CTE.
const WRITE_WORDS = new Set(['insert', 'update', 'delete', 'merge', 'truncate', 'drop', 'alter', 'create', 'grant', 'revoke', 'into', 'call', 'vacuum', 'lock', 'refresh', 'reindex', 'cluster', 'do'])

// Functions with side effects: sequences, settings, backends, advisory locks, large objects, remote access, server files, sleeping and transaction ids.
const SIDE_EFFECT_FUNCTIONS = /^(?:nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_restore_point|pg_advisory_lock\w*|pg_advisory_xact_lock\w*|pg_try_advisory\w*|pg_notify|lo_\w+|dblink\w*|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|pg_sleep\w*|pg_export_snapshot|pg_backup_start|pg_backup_stop|pg_start_backup|pg_stop_backup|txid_current|pg_current_xact_id|pg_current_logfile|pg_wal_replay_\w+|\w+_to_xml\w*|pg_logical_\w+|pg_replication_\w+|pg_drop_replication_slot|pg_stat_reset\w*|pg_promote|pg_file_\w+|sleep|benchmark|get_lock|release_lock|release_all_locks|load_file|master_pos_wait|source_pos_wait|sys_exec|sys_eval)$/

// Splits SQL into words and punctuation, dropping comments and the content of strings, quoted identifiers and dollar-quoted bodies, but keeping what a MySQL or MariaDB `/*! ... */` comment runs. With `mysql` its own rules apply: `#` comments, backslash escapes in strings, double quotes as strings, comments that do not nest.
export function tokenize(sql: string, dialect: Dialect = 'postgres'): Token[] {
  const tokens: Token[] = []
  const isMysql = dialect === 'mysql'
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
    else if ((char === '-' && next === '-' && (!isMysql || isDashGap(sql.charAt(at + 2)))) || (isMysql && char === '#')) {
      const end = sql.slice(at).search(LINE_END)

      at = end === -1 ? sql.length : at + end + 1
    }
    else if (char === '/' && next === '*' && (sql.charAt(at + 2) === '!' || (sql.charAt(at + 2) === 'M' && sql.charAt(at + 3) === '!'))) {
      at += sql.charAt(at + 2) === '!' ? 3 : 4

      while (DIGITS.test(sql.charAt(at)))
        at++
    }
    else if (char === '/' && next === '*') {
      at = skipComment(sql, at, !isMysql)
    }
    else if (char === '\'' || (isMysql && char === '"')) {
      const backslashes = isMysql || (ESCAPE_PREFIX.test(sql.charAt(at - 1)) && !WORD_PART.test(sql.charAt(at - 2)))
      const end = skipQuoted(sql, at, char, backslashes)

      at = end ?? sql.length
      tokens.push({ kind: 'punct', text: end === undefined ? UNCLOSED : '\'' })
    }
    // A backtick quotes an identifier in MySQL, which clients.ts also checks with this tokenizer.
    else if (char === '"' || char === '`') {
      const end = skipQuoted(sql, at, char, false)

      if (char === '"' && UNICODE_PREFIX.test(sql.slice(Math.max(0, at - 2), at)) && !WORD_PART.test(sql.charAt(at - 3)))
        tokens.push({ kind: 'punct', text: UNICODE_IDENTIFIER })

      tokens.push(end === undefined ? { kind: 'punct', text: UNCLOSED } : { kind: 'quoted', text: sql.slice(at + 1, end - 1).replaceAll(char + char, char) })
      at = end ?? sql.length
    }
    else if (!isMysql && char === '$' && DOLLAR_TAG.test(sql.slice(at))) {
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

// MySQL ends a `--` comment only when a blank or control character, or the end of the text, follows the dashes.
function isDashGap(char: string): boolean {
  return char <= ' '
}

// Index just past a block comment, which Postgres lets nest and MySQL does not.
function skipComment(sql: string, start: number, nests: boolean): number {
  let depth = 0
  let at = start

  while (at < sql.length) {
    if (sql.startsWith('/*', at) && (nests || depth === 0)) {
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
      if (index !== start || PRIVILEGED_SET.has(statement[index + 1]?.text ?? '') || (isPunct(statement[index + 1], '@') && isPunct(statement[index + 2], '@')))
        reasons.push('uses SET')
    }
    else if (index === start && WRITING_STARTS.has(token.text)) {
      reasons.push(`uses ${token.text.toUpperCase()}`)
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
export function writes(sql: string, dialect: Dialect = 'postgres'): string[] {
  return [...new Set(splitStatements(tokenize(sql, dialect)).flatMap(statementWrites))]
}

// Judges SQL before it runs: anything not plainly a read comes back with the reasons.
export function inspect(sql: string, dialect: Dialect = 'postgres'): Verdict {
  const statements = splitStatements(tokenize(sql, dialect))
  const reasons: string[] = []

  for (const statement of statements) {
    const first = statement[0]

    if (first?.kind !== 'word' || !READ_STARTS.has(first.text))
      reasons.push(`starts with ${first?.text ?? 'nothing'}, not a read`)

    reasons.push(...statementWrites(statement))
  }

  return { reasons: [...new Set(reasons)], statements: statements.length }
}

// What a write may start with on a test database: anything else (USE, SET, CALL, DO, COPY, PREPARE, GRANT, a psql meta-command...) can reach past the database.
const TEST_WRITE_STARTS = new Set(['insert', 'update', 'delete', 'replace', 'merge', 'truncate', 'create', 'alter', 'drop', 'rename', 'with', 'select', 'values', 'table', 'comment', 'refresh'])
const DEFINITION_STARTS = new Set(['create', 'alter', 'drop', 'rename'])
// Code the server runs later or on its own, past this check: an event's body can drop another database, a function's body hides behind $$.
const STORED_CODE = new Set(['event', 'procedure', 'function', 'trigger', 'rule', 'aggregate'])
const DEFINITION_MODIFIERS = new Set(['or', 'replace', 'temporary', 'temp', 'unlogged', 'unique', 'fulltext', 'spatial', 'definer'])
// Objects a definition may name that belong to the server, not to the database: dropping one reaches another database or the server's accounts.
const SERVER_OBJECTS = new Set(['database', 'user', 'role', 'server', 'tablespace', 'extension', 'system', 'subscription', 'publication', 'logfile', 'instance', 'resource'])
const FILE_WORDS = new Set(['infile', 'outfile', 'dumpfile'])
// Allowed in a test database though they change a sequence.
const SEQUENCE_FUNCTIONS = new Set(['nextval', 'setval'])

// Databases named by a qualified name `other.table`, which reads or writes past the one connected to: MySQL qualifies any name with a database. A table alias used as a qualifier counts too, which errs on the side of refusing.
function foreignDatabases(statement: Token[], database: string): string[] {
  const found: string[] = []

  for (const [index, token] of statement.entries()) {
    // A system variable, `@@global.x`, is no database.
    if ((token.kind === 'word' || token.kind === 'quoted') && !isPunct(statement[index - 1], '@') && isPunct(statement[index + 1], '.') && !isPunct(statement[index - 1], '.') && token.text.toLowerCase() !== database.toLowerCase())
      found.push(token.text)
  }

  return found
}

function definesServerObject(statement: Token[], dialect: Dialect): string | null {
  if (!DEFINITION_STARTS.has(statement[0]?.text ?? ''))
    return null

  const kind = statement.slice(1).find(token => !DEFINITION_MODIFIERS.has(token.text))?.text ?? ''

  if (STORED_CODE.has(kind) && statement[0]?.text !== 'drop')
    return kind

  // a definer clause only heads a view, an event, a procedure, a function or a trigger
  if (statement[0]?.text !== 'drop' && statement.some(token => token.kind === 'word' && token.text === 'definer'))
    return 'definer'

  return SERVER_OBJECTS.has(kind) || (dialect === 'mysql' && kind === 'schema') ? kind : null
}

// Why a write cannot run even on a database ending in `_test`, empty when it can: more than one statement, a start that is not plain DML or DDL, a definition of a server object, another database named, files, or a function with a side effect outside the database. `database` is the one connected to.
export function testWriteBlockers(sql: string, dialect: Dialect, database: string): string[] {
  const statements = splitStatements(tokenize(sql, dialect))
  const reasons: string[] = []

  if (statements.length > 1)
    reasons.push('several statements')

  for (const statement of statements) {
    const [first] = statement
    const serverObject = definesServerObject(statement, dialect)

    if (first?.kind !== 'word' || !TEST_WRITE_STARTS.has(first.text))
      reasons.push(`starts with ${first?.text ?? 'nothing'}`)

    if (serverObject !== null)
      reasons.push(`defines a ${serverObject}`)

    if (dialect === 'mysql')
      reasons.push(...foreignDatabases(statement, database).map(name => `names the database ${name}`))

    for (const [index, token] of statement.entries()) {
      if (isPunct(token, UNCLOSED) || isPunct(token, NUL) || isPunct(token, UNICODE_IDENTIFIER) || isPunct(token, '\\'))
        reasons.push('has a quote that never closes, a NUL byte, an escaped identifier or a meta-command')
      else if (token.kind !== 'punct' && ((SIDE_EFFECT_FUNCTIONS.test(token.text) && !SEQUENCE_FUNCTIONS.has(token.text)) || (token.kind === 'word' && (FILE_WORDS.has(token.text) || token.text === 'federated' || (token.text === 'connection' && isPunct(statement[index + 1], '='))))))
        reasons.push(`uses ${token.text}`)
    }
  }

  return [...new Set(reasons)]
}
