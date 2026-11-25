import { describe, expect, it } from 'bun:test'
import { wrapToWidth } from '../src/text'

describe('wrapToWidth', () => {
  it('breaks at the last space that keeps a line within the width', () => {
    expect(wrapToWidth('one two three', 7)).toEqual(['one two', 'three'])
    expect(wrapToWidth('one two three', 6)).toEqual(['one', 'two', 'three'])
  })

  it('keeps a word wider than the width whole on its own line', () => {
    expect(wrapToWidth('a abcdefgh b', 4)).toEqual(['a', 'abcdefgh', 'b'])
  })

  it('measures wide characters and escapes as drawn', () => {
    expect(wrapToWidth('日本 語', 4)).toEqual(['日本', '語'])
    expect(wrapToWidth('\x1B[36mab\x1B[39m cd', 5)).toEqual(['\x1B[36mab\x1B[39m cd'])
  })

  it('gives no line for empty text', () => {
    expect(wrapToWidth('', 10)).toEqual([])
  })
})
