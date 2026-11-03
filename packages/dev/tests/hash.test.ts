import { describe, expect, test } from 'bun:test'
import { hashHex } from '../src/hash'

const abc = new TextEncoder().encode('abc')

describe('hashHex', () => {
  test('known vectors of "abc"', () => {
    expect(hashHex('sha256', abc)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hashHex('sha1', abc)).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(hashHex('md5', abc)).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(hashHex('sha512', abc)).toBe('ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f')
  })

  test('the empty input', () => {
    expect(hashHex('sha256', new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})
