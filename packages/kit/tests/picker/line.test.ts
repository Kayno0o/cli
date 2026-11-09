import { describe, expect, test } from 'bun:test'
import { editLine, visible } from '../../src/picker/line'

const at = (text: string, caret: number) => ({ text, caret })

describe('editLine', () => {
  test('types and erases at the caret, a character of several code units counting as one', () => {
    expect(editLine(at('ac', 1), { text: 'b' })).toEqual(at('abc', 2))
    expect(editLine(at('a😀c', 2), 'erase')).toEqual(at('ac', 1))
    expect(editLine(at('abc', 1), 'delete')).toEqual(at('ac', 1))
    expect(editLine(at('abc', 0), 'erase')).toEqual(at('abc', 0))
    expect(editLine(at('abc', 3), 'delete')).toEqual(at('abc', 3))
  })

  test('moves by a character, a word and to either end, stopping there', () => {
    const url = 'https://ex.fr/reset/de3a'

    expect(editLine(at(url, 24), 'wordleft').caret).toBe(20)
    expect(editLine(at(url, 20), 'wordleft').caret).toBe(14)
    expect(editLine(at(url, 0), 'wordright').caret).toBe(5)
    expect(editLine(at(url, 5), 'wordright').caret).toBe(10)
    expect(editLine(at(url, 0), 'left').caret).toBe(0)
    expect(editLine(at(url, 24), 'right').caret).toBe(24)
    expect(editLine(at(url, 9), 'linestart').caret).toBe(0)
    expect(editLine(at(url, 9), 'lineend').caret).toBe(24)
  })

  test('Ctrl+W takes back to a space, Ctrl+Backspace and Alt+D a word, Ctrl+U and Ctrl+K a side', () => {
    expect(editLine(at('open https://ex.fr/a ', 21), 'word')).toEqual(at('open ', 5))
    expect(editLine(at('https://ex.fr/reset', 19), 'killword')).toEqual(at('https://ex.fr/', 14))
    expect(editLine(at('one two three', 3), 'killnext')).toEqual(at('one three', 3))
    expect(editLine(at('one two', 4), 'clear')).toEqual(at('two', 0))
    expect(editLine(at('one two', 3), 'killend')).toEqual(at('one', 3))
  })
})

describe('visible', () => {
  test('shows a line that fits whole, the caret at the end taking a cell', () => {
    expect(visible(at('abc', 3), 4)).toEqual({ before: 'abc', at: undefined, after: '', column: 3 })
    expect(visible(at('abc', 1), 3)).toEqual({ before: 'a', at: 'b', after: 'c', column: 1 })
  })

  test('cuts a longer line around the caret, an ellipsis for each side cut', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz'

    expect(visible(at(text, 26), 8)).toEqual({ before: '…uvwxyz', at: undefined, after: '', column: 7 })
    expect(visible(at(text, 0), 8)).toEqual({ before: '', at: 'a', after: 'bcdefg…', column: 0 })
    expect(visible(at(text, 13), 8)).toEqual({ before: '…ijklm', at: 'n', after: '…', column: 6 })
  })
})
