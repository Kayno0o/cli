import type { Dialect, Token } from './sql-tokens'
import { isPunct, SIDE_EFFECT_FUNCTIONS } from './guard'
import { NUL, splitStatements, tokenize, UNCLOSED, UNICODE_IDENTIFIER } from './sql-tokens'

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

const EXISTENCE_WORDS = new Set(['if', 'not', 'exists'])

// The databases other than `database` a statement reaches: a qualified name (MySQL), a database it creates, alters or drops, or one it switches to with USE. `database` is empty when the one connected to is unknown.
export function otherDatabases(sql: string, dialect: Dialect, database: string): string[] {
  const found: string[] = []

  for (const statement of splitStatements(tokenize(sql, dialect))) {
    if (dialect === 'mysql')
      found.push(...foreignDatabases(statement, database))

    const first = statement[0]?.text ?? ''
    const kind = statement.findIndex((token, index) => index > 0 && !DEFINITION_MODIFIERS.has(token.text))
    const isDatabase = DEFINITION_STARTS.has(first) && (statement[kind]?.text === 'database' || (dialect === 'mysql' && statement[kind]?.text === 'schema'))
    let named: Token | undefined

    if (first === 'use')
      named = statement[1]
    else if (isDatabase)
      named = statement.slice(kind + 1).find(token => !EXISTENCE_WORDS.has(token.text))

    if (named !== undefined && named.kind !== 'punct' && named.text.toLowerCase() !== database.toLowerCase())
      found.push(named.text)
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
