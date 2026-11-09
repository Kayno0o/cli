import { describe, expect, test } from 'bun:test'
import { parseFields, pickFields, splitFields } from '../src/fields'

const take = (expression: string, line: string, delimiter?: RegExp): string => pickFields(line, parseFields(expression)!, delimiter)

describe('fields', () => {
  test('splits on whitespace by default and keeps the delimiter that ends a field', () => {
    expect(splitFields('  a b\tc ', undefined)).toEqual(['  a ', 'b\t', 'c '])
    expect(splitFields('a:b:c', /:/)).toEqual(['a:', 'b:', 'c'])
  })

  test('reads fzf field expressions', () => {
    expect(take('2', 'a b c')).toBe('b ')
    expect(take('-1', 'a b c')).toBe('c')
    expect(take('2..', 'a b c')).toBe('b c')
    expect(take('..2', 'a b c')).toBe('a b ')
    expect(take('1..2', 'a b c')).toBe('a b ')
    expect(take('1,3', 'a b c')).toBe('a c')
    expect(take('..', 'a b c')).toBe('a b c')
    expect(take('5', 'a b c')).toBe('')
    expect(take('2', 'x:y:z', /:/)).toBe('y:')
  })

  test('rejects what is not a field expression', () => {
    expect(parseFields('0')).toBeUndefined()
    expect(parseFields('a')).toBeUndefined()
    expect(parseFields('')).toBeUndefined()
  })
})
