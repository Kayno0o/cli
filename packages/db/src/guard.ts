export interface Token {
  kind: 'word' | 'punct'
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
const COMMAND_ENDS = ';'

// Statements that may start a read.
const READ_STARTS = new Set(['select', 'with', 'values', 'table', 'show', 'explain'])

// Words that write or lock wherever they appear in a statement that started like a read, such as a DELETE inside a CTE.
const WRITE_WORDS = new Set(['insert', 'update', 'delete', 'merge', 'truncate', 'drop', 'alter', 'create', 'grant', 'revoke', 'into', 'set', 'copy', 'call', 'vacuum', 'lock', 'refresh', 'reindex', 'cluster'])

// Functions with side effects: sequences, settings, backends, advisory locks, large objects, remote access and server files.
const SIDE_EFFECT_FUNCTIONS = /^(?:nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_restore_point|pg_advisory_lock\w*|pg_advisory_xact_lock\w*|pg_try_advisory\w*|pg_notify|lo_\w+|dblink\w*|pg_read_file|pg_read_binary_file|pg_ls_dir|query_to_xml\w*|pg_logical_\w+|pg_replication_\w+|pg_drop_replication_slot|pg_stat_reset\w*|pg_promote|pg_file_\w+)$/

// Splits SQL into words and punctuation, dropping comments and the content of strings, quoted identifiers and dollar-quoted bodies.
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let at = 0

  while (at < sql.length) {
    const char = sql.charAt(at)
    const next = sql.charAt(at + 1)

    if (SPACE.test(char)) {
      at++
    }
    else if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', at)

      at = end === -1 ? sql.length : end + 1
    }
    else if (char === '/' && next === '*') {
      at = skipComment(sql, at)
    }
    else if (char === '\'' || char === '"') {
      const backslashes = char === '\'' && ESCAPE_PREFIX.test(sql.charAt(at - 1)) && !WORD_PART.test(sql.charAt(at - 2))

      at = skipQuoted(sql, at, char, backslashes)
      tokens.push({ kind: 'punct', text: char })
    }
    else if (char === '$' && DOLLAR_TAG.test(sql.slice(at))) {
      const tag = DOLLAR_TAG.exec(sql.slice(at))?.[0] ?? '$$'
      const end = sql.indexOf(tag, at + tag.length)

      at = end === -1 ? sql.length : end + tag.length
      tokens.push({ kind: 'punct', text: '$' })
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

// Index just past the closing quote, where a doubled quote is an escaped one.
function skipQuoted(sql: string, start: number, quote: string, backslashes: boolean): number {
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

  return sql.length
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

// Judges SQL before it runs: anything not plainly a read comes back with the reasons.
export function inspect(sql: string): Verdict {
  const statements = splitStatements(tokenize(sql))
  const reasons: string[] = []

  for (const statement of statements) {
    const first = statement[0]

    if (first?.kind !== 'word' || !READ_STARTS.has(first.text))
      reasons.push(`starts with ${first?.text ?? 'nothing'}, not a read`)

    for (const [index, token] of statement.entries()) {
      if (token.kind !== 'word')
        continue

      if (WRITE_WORDS.has(token.text))
        reasons.push(`uses ${token.text.toUpperCase()}`)
      else if (token.text === 'analyze' && first?.text !== 'explain')
        reasons.push('uses ANALYZE')
      else if (SIDE_EFFECT_FUNCTIONS.test(token.text))
        reasons.push(`calls ${token.text}`)
      else if (token.text === 'for' && LOCK_KIND.test(statement[index + 1]?.text ?? ''))
        reasons.push('takes row locks with FOR UPDATE or SHARE')
    }
  }

  return { reasons: [...new Set(reasons)], statements: statements.length }
}
