import type { Dialect, Token } from './sql-tokens'
import { NUL, splitStatements, tokenize, UNCLOSED, UNICODE_IDENTIFIER } from './sql-tokens'

const LOCK_KIND = /^(?:update|share|no|key)$/
// A SET starting a statement changes a session setting, harmless unless it switches the role or the transaction's access mode, or in MySQL changes the server (`SET GLOBAL`, `SET PERSIST`, `SET PASSWORD`).
const PRIVILEGED_SET = new Set(['role', 'session', 'transaction', 'global', 'persist', 'persist_only', 'password', 'default'])
// Statements that may start a read.
const READ_STARTS = new Set(['select', 'with', 'values', 'table', 'show', 'explain', 'describe', 'desc'])
// Statements that write, change the server or hide what they run (a prepared statement's text is a string), whatever follows; elsewhere these words are common column names.
const WRITING_STARTS = new Set(['replace', 'load', 'rename', 'flush', 'kill', 'shutdown', 'install', 'uninstall', 'purge', 'optimize', 'repair', 'import', 'prepare', 'execute'])
// Words that write or lock wherever they appear in a statement that started like a read, such as a DELETE inside a CTE.
const WRITE_WORDS = new Set(['insert', 'update', 'delete', 'merge', 'truncate', 'drop', 'alter', 'create', 'grant', 'revoke', 'into', 'call', 'vacuum', 'lock', 'refresh', 'reindex', 'cluster', 'do'])

// Functions with side effects: sequences, settings, backends, advisory locks, large objects, remote access, server files, sleeping and transaction ids.
export const SIDE_EFFECT_FUNCTIONS = /^(?:nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_restore_point|pg_advisory_lock\w*|pg_advisory_xact_lock\w*|pg_try_advisory\w*|pg_notify|lo_\w+|dblink\w*|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|pg_sleep\w*|pg_export_snapshot|pg_backup_start|pg_backup_stop|pg_start_backup|pg_stop_backup|txid_current|pg_current_xact_id|pg_current_logfile|pg_wal_replay_\w+|\w+_to_xml\w*|pg_logical_\w+|pg_replication_\w+|pg_drop_replication_slot|pg_stat_reset\w*|pg_promote|pg_file_\w+|sleep|benchmark|get_lock|release_lock|release_all_locks|load_file|master_pos_wait|source_pos_wait|sys_exec|sys_eval)$/

export interface Verdict {
  // Why the SQL cannot be trusted to only read, empty when it can.
  reasons: string[]
  statements: number
}

export const isPunct = (token: Token | undefined, text: string) => token?.kind === 'punct' && token.text === text

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

export { testWriteBlockers } from './guard-test'
export type { Dialect, Token } from './sql-tokens'
export { splitStatements, tokenize } from './sql-tokens'
