import { describe, expect, test } from 'bun:test'
import { b64Decode, b64Encode } from '../src/encode'

const text = (value: string) => new TextEncoder().encode(value)
const read = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('b64Encode', () => {
  test('pads the standard alphabet', () => {
    expect(b64Encode(text('hello'))).toBe('aGVsbG8=')
    expect(b64Encode(Uint8Array.from([0xFB, 0xFF, 0xFE]))).toBe('+//+')
  })

  test('--url swaps the alphabet and drops the padding', () => {
    expect(b64Encode(text('hello'), true)).toBe('aGVsbG8')
    expect(b64Encode(Uint8Array.from([0xFB, 0xFF, 0xFE]), true)).toBe('-__-')
  })

  test('empty is empty', () => {
    expect(b64Encode(new Uint8Array())).toBe('')
  })
})

describe('b64Decode', () => {
  test('takes either alphabet, padded or not, and whitespace', () => {
    expect(read(b64Decode('aGVsbG8='))).toBe('hello')
    expect(read(b64Decode('aGVsbG8'))).toBe('hello')
    expect(read(b64Decode(' aGVs\nbG8= \n'))).toBe('hello')
    expect(b64Decode('-__-')).toEqual(Uint8Array.from([0xFB, 0xFF, 0xFE]))
    expect(b64Decode('+//+')).toEqual(Uint8Array.from([0xFB, 0xFF, 0xFE]))
  })

  test('round-trips UTF-8', () => {
    expect(read(b64Decode(b64Encode(text('héllo wörld ✓'))))).toBe('héllo wörld ✓')
  })

  test('refuses what is not base64', () => {
    expect(() => b64Decode('a$b=')).toThrow('not valid base64')
    expect(() => b64Decode('a')).toThrow('not valid base64')
    expect(() => b64Decode('ab=cd')).toThrow('not valid base64')
  })
})
