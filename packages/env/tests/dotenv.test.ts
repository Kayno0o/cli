import { describe, expect, test } from 'bun:test'
import { entries, parseDotenv, removeKey, serializeDotenv, setLine } from '../src/dotenv'

const SAMPLE = `# database
DB_URL=postgres://app:hunter22@db:5432/app
export TOKEN="abc def"
EMPTY=
PLAIN=value # trailing comment
SINGLE='it is $HOME'
PEM="-----BEGIN KEY-----
line one
-----END KEY-----"
ESCAPED="a\\nb \\"quoted\\""
`

describe('parseDotenv', () => {
  test('reads plain, quoted, exported, empty and commented values', () => {
    const map = entries(parseDotenv(SAMPLE))

    expect(map.get('DB_URL')).toBe('postgres://app:hunter22@db:5432/app')
    expect(map.get('TOKEN')).toBe('abc def')
    expect(map.get('EMPTY')).toBe('')
    expect(map.get('PLAIN')).toBe('value')
    expect(map.get('SINGLE')).toBe('it is $HOME')
    expect(map.get('ESCAPED')).toBe('a\nb "quoted"')
  })

  test('reads a multiline quoted value as one entry', () => {
    const file = parseDotenv(SAMPLE)

    expect(entries(file).get('PEM')).toBe('-----BEGIN KEY-----\nline one\n-----END KEY-----')
    expect(file.lines.find(line => line.key === 'PEM')?.raw.split('\n')).toHaveLength(3)
  })

  test('round-trips untouched, comments and blank lines included', () => {
    expect(serializeDotenv(parseDotenv(SAMPLE))).toBe(SAMPLE)
    expect(serializeDotenv(parseDotenv('A=1\r\nB=2\r\n'))).toBe('A=1\r\nB=2\r\n')
  })

  test('keeps the last value of a repeated key', () => {
    expect(entries(parseDotenv('A=1\nA=2\n')).get('A')).toBe('2')
  })
})

describe('editing', () => {
  test('replaces a line in place, keeping export, comments and order', () => {
    const file = parseDotenv('# top\nexport A=1\nB=2\n')

    setLine(file, 'A', 'new value')

    expect(serializeDotenv(file)).toBe('# top\nexport A="new value"\nB=2\n')
  })

  test('appends before the trailing newline, or to an empty file', () => {
    const file = parseDotenv('A=1\n')

    setLine(file, 'B', 'two')
    expect(serializeDotenv(file)).toBe('A=1\nB=two\n')

    const empty = parseDotenv('')

    setLine(empty, 'A', 'x')
    expect(serializeDotenv(empty)).toBe('A=x\n')
  })

  test('keeps a replaced line\'s CRLF and inline comment, and appends with CRLF', () => {
    const file = parseDotenv('A=1\r\nB=2 # note\r\nC="3" # quoted\r\n')

    setLine(file, 'B', 'x')
    setLine(file, 'C', 'y z')
    setLine(file, 'D', 'd')

    expect(serializeDotenv(file)).toBe('A=1\r\nB=x # note\r\nC="y z" # quoted\r\nD=d\r\n')

    const unended = parseDotenv('A=1\r\nB=2')

    setLine(unended, 'C', '3')
    expect(serializeDotenv(unended)).toBe('A=1\r\nB=2\r\nC=3\r\n')

    const blank = parseDotenv('B= # note\n')

    setLine(blank, 'B', 'x')
    expect(serializeDotenv(blank)).toBe('B=x # note\n')
  })

  test('quotes and escapes a value that needs it, and reads it back', () => {
    const file = parseDotenv('')

    setLine(file, 'A', 'line one\nsay "hi" # now')

    expect(entries(parseDotenv(serializeDotenv(file))).get('A')).toBe('line one\nsay "hi" # now')
  })

  test('removes every line of a key only', () => {
    const file = parseDotenv('# c\nA=1\nB=2\nA=3\n')

    expect(removeKey(file, 'A')).toBe(2)
    expect(serializeDotenv(file)).toBe('# c\nB=2\n')
  })
})

describe('unterminated quote', () => {
  test('ends at its own line when no quote closes it, as Bun reads it', () => {
    const file = parseDotenv('A=1\nKEY="oops\nB=2\nC=3\n')
    const map = entries(file)

    expect(map.get('KEY')).toBe('"oops')
    expect(map.get('B')).toBe('2')
    expect(map.get('C')).toBe('3')
    expect(file.lines[1]?.unterminated).toBe(true)
    expect(serializeDotenv(file)).toBe('A=1\nKEY="oops\nB=2\nC=3\n')
  })

  test('still spans lines up to the closing quote', () => {
    const map = entries(parseDotenv('PEM="a\nb\nc"\nB=2\n'))

    expect(map.get('PEM')).toBe('a\nb\nc')
    expect(map.get('B')).toBe('2')
  })

  test('reads a body line shaped like an assignment as part of the value, and set and unset take every line', () => {
    const text = 'K="-----BEGIN-----\nQmFzZTY0IGVuZGluZw==\n-----END-----"\nB=2\n'

    expect([...entries(parseDotenv(text))]).toEqual([['K', '-----BEGIN-----\nQmFzZTY0IGVuZGluZw==\n-----END-----'], ['B', '2']])

    const set = parseDotenv(text)

    setLine(set, 'K', 'new')
    expect(serializeDotenv(set)).toBe('K=new\nB=2\n')

    const unset = parseDotenv(text)

    expect(removeKey(unset, 'K')).toBe(1)
    expect(serializeDotenv(unset)).toBe('B=2\n')
  })
})
