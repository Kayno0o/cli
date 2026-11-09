import { describe, expect, test } from 'bun:test'
import { parseBlocks } from '../src/blocks'
import { applyPairs, listLines } from '../src/replace'

describe('parseBlocks', () => {
  test('reads blocks, a file name line naming the next one', () => {
    expect(parseBlocks('<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\nsrc/x.ts\n<<<<<<< SEARCH\nc\n=======\n\n>>>>>>> REPLACE\n')).toEqual([
      { file: undefined, from: 'a', to: 'b' },
      { file: 'src/x.ts', from: 'c', to: '' },
    ])
  })

  test('reads CRLF text and multi-line sides', () => {
    expect(parseBlocks('<<<<<<< SEARCH\r\na\r\nb\r\n=======\r\nc\r\n>>>>>>> REPLACE\r\n')).toEqual([{ file: undefined, from: 'a\nb', to: 'c' }])
  })

  test('a longer opener keeps shorter marker lines as text', () => {
    expect(parseBlocks('<<<<<<<<<< SEARCH\n=======\n==========\nx\n>>>>>>>>>> REPLACE')).toEqual([{ file: undefined, from: '=======', to: 'x' }])
  })

  test.each([
    ['no block', '\n', 'no <<<<<<< SEARCH block found'],
    ['no divider', '<<<<<<< SEARCH\na\n', 'never reaches its ======= line and >>>>>>> REPLACE line'],
    ['no closer', '<<<<<<< SEARCH\na\n=======\nb\n', 'never reaches its >>>>>>> REPLACE line'],
    ['a file name left alone', '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\nsrc/x.ts\n', 'is not followed by a block'],
    ['two file names', 'a.ts\nb.ts\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE', 'after the file name "a.ts"'],
  ])('refuses %s', (_, text, message) => {
    const parsed = parseBlocks(text)

    expect(typeof parsed).toBe('string')
    expect(parsed).toContain(message)
  })
})

describe('applyPairs', () => {
  test('replaces one match and reports its line', () => {
    expect(applyPairs('a\nb\nc', [{ from: 'b', to: 'B' }])).toEqual({ text: 'a\nB\nc', lines: [2], problems: [], matched: 1 })
  })

  test('refuses a count that is not the expected one, listing the lines', () => {
    const { text, problems } = applyPairs('x\nx\n', [{ from: 'x', to: 'y' }])

    expect(text).toBe('x\nx\n')
    expect(problems[0]).toContain('matched 2 times, expected 1 on lines 1, 2')
  })

  test('--count and --all accept several, --all still wants one', () => {
    expect(applyPairs('x x', [{ from: 'x', to: 'y', count: 2 }]).text).toBe('y y')
    expect(applyPairs('x x x', [{ from: 'x', to: 'y', all: true }]).text).toBe('y y y')
    expect(applyPairs('z', [{ from: 'x', to: 'y', all: true }]).problems[0]).toContain('expected at least 1')
  })

  test('names where the first line of a text that matched nowhere does appear', () => {
    expect(applyPairs('  foo\nbar', [{ from: 'foo\nbaz', to: '' }]).problems[0]).toContain('its first line is on line 1')
  })

  test('pairs run in order and label their problems', () => {
    const { text, problems } = applyPairs('a', [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }])

    expect(text).toBe('b')
    expect(problems).toEqual(['pair 2: matched 0 times, expected 1'])
  })

  test('regex pairs take braced groups, digits after one included, and anchor per line', () => {
    const to = ['$', '{2}1', '$', '{1}'].join('')

    expect(applyPairs('ab\ncd', [{ from: '^(.)(.)$', to, regex: true, all: true }]).text).toBe('b1a\nd1c')
  })

  test('a plain newline in --from matches a CRLF file and keeps CRLF', () => {
    expect(applyPairs('a\r\nb\r\n', [{ from: 'a\nb', to: 'c\nd' }]).text).toBe('c\r\nd\r\n')
  })

  test('a plain newline in a regex --to keeps CRLF too', () => {
    expect(applyPairs('a\r\nb\r\n', [{ from: '^a', to: 'x\ny', regex: true }]).text).toBe('x\r\ny\r\nb\r\n')
  })
})

describe('listLines', () => {
  test('shows eight lines and counts the rest', () => {
    expect(listLines([1, 2, 3])).toBe('1, 2, 3')
    expect(listLines([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe('1, 2, 3, 4, 5, 6, 7, 8 and 2 more')
  })
})
