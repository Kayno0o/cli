import { describe, expect, test } from 'bun:test'
import { fuzzy, rank } from '../../src/picker/score'

const scoreOf = (query: string, text: string): number => fuzzy(query, text)?.score ?? Number.NEGATIVE_INFINITY

describe('fuzzy', () => {
  test('matches a subsequence and reports where', () => {
    expect(fuzzy('abc', 'a-b-c')?.positions).toEqual([0, 2, 4])
    expect(fuzzy('xyz', 'a-b-c')).toBeUndefined()
    expect(fuzzy('ba', 'ab')).toBeUndefined()
    expect(fuzzy('', 'anything')).toEqual({ score: 0, positions: [] })
  })

  test('a run of consecutive characters beats scattered ones', () => {
    expect(scoreOf('abc', 'xabcx')).toBeGreaterThan(scoreOf('abc', 'xaxbxcx'))
  })

  test('a word start beats the middle of a word', () => {
    expect(scoreOf('b', 'foo-bar')).toBeGreaterThan(scoreOf('b', 'foobar'))
    expect(scoreOf('b', 'fooBar')).toBeGreaterThan(scoreOf('b', 'foobar'))
    expect(scoreOf('b', 'a/b')).toBeGreaterThan(scoreOf('b', 'aab'))
  })

  test('a prefix beats the same match later in the text', () => {
    expect(scoreOf('src', 'src/index.ts')).toBeGreaterThan(scoreOf('src', 'lib/src/index.ts'))
  })

  test('takes the best alignment, not the first one', () => {
    expect(fuzzy('fb', 'xfxxfb')?.positions).toEqual([4, 5])
  })

  test('case is smart: lowercase ignores it, an uppercase letter makes the query exact', () => {
    expect(fuzzy('readme', 'README.md')?.positions).toEqual([0, 1, 2, 3, 4, 5])
    expect(fuzzy('Readme', 'README.md')).toBeUndefined()
    expect(fuzzy('README', 'README.md')).toBeDefined()
    expect(fuzzy('Rd', 'Readme')).toBeDefined()
  })

  test('does not match past the end', () => {
    expect(fuzzy('abcd', 'abc')).toBeUndefined()
  })
})

describe('rank', () => {
  const lines = ['lib/src/index.ts', 'src/index.ts', 'docs/readme.md', 'src']

  test('keeps the input order for an empty query', () => {
    expect(rank('', lines).map(match => match.index)).toEqual([0, 1, 2, 3])
  })

  test('drops what does not match and puts the best first, shorter lines winning a tie', () => {
    expect(rank('src', lines).map(match => lines[match.index])).toEqual(['src', 'src/index.ts', 'lib/src/index.ts'])
  })
})
