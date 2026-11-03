// A name may hold any non-ASCII character in MySQL and Postgres, so one belongs to a word and never stands as punctuation.
const WORD_START = /[a-z_\P{ASCII}]/iu
const WORD_PART = /[\w$\P{ASCII}]/u
const SPACE = /\s/
const ESCAPE_PREFIX = /e/i
const DOLLAR_TAG = /^\$(?:[a-z_]\w*)?\$/i
const DIGITS = /\d/
const COMMAND_ENDS = ';'

// Stands for a quote or dollar-quoted body that never closes, which hides the rest of the text.
export const UNCLOSED = 'unclosed'
// Stand for a NUL byte, and for a `U&"..."` identifier whose escapes can spell any name.
export const NUL = '\0'
export const UNICODE_IDENTIFIER = 'U&"'
const UNICODE_PREFIX = /u&$/i
const LINE_END = /[\r\n]/

// The SQL a server reads: the two differ in comments, string escapes and quoting, which decides what hides behind a quote.
export type Dialect = 'postgres' | 'mysql'

export interface Token {
  // A quoted identifier is its unescaped content, kept apart from keywords: `"set"` is a name while `set` is a command.
  kind: 'word' | 'punct' | 'quoted'
  text: string
}

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
