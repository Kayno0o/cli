import { describe, expect, test } from 'bun:test'
import { bcryptHash, generatePassword } from '../src/password'

function fixed(...bytes: number[]) {
  return (target: Uint8Array) => {
    target.set(bytes.slice(0, target.length))

    return target
  }
}

describe('generatePassword', () => {
  test('hex is two characters per byte', () => {
    expect(generatePassword(3, 'hex', fixed(0xDE, 0xAD, 0x01))).toBe('dead01')
    expect(generatePassword(16, 'hex')).toMatch(/^[0-9a-f]{32}$/)
  })

  test('base64 is padded, as openssl rand -base64 is', () => {
    expect(generatePassword(3, 'base64', fixed(0xFB, 0xFF, 0xFE))).toBe('+//+')
    expect(generatePassword(1, 'base64', fixed(0xFF))).toBe('/w==')
    expect(generatePassword(32, 'base64')).toHaveLength(44)
  })

  test('base64url swaps +/ for -_ and drops the padding', () => {
    expect(generatePassword(3, 'base64url', fixed(0xFB, 0xFF, 0xFE))).toBe('-__-')
    expect(generatePassword(1, 'base64url', fixed(0xFF))).toBe('_w')
  })

  test('two draws differ', () => {
    expect(generatePassword(32, 'hex')).not.toBe(generatePassword(32, 'hex'))
  })
})

describe('bcryptHash', () => {
  test('writes the $2y$ prefix at cost 10 and verifies against the password', async () => {
    const hash = await bcryptHash('hunter2')

    expect(hash).toMatch(/^\$2y\$10\$[./A-Za-z0-9]{53}$/)
    expect(await Bun.password.verify('hunter2', hash.replace('$2y$', '$2b$'))).toBe(true)
    expect(await Bun.password.verify('hunter3', hash.replace('$2y$', '$2b$'))).toBe(false)
  })

  test('verifies a hash htpasswd wrote with $2y$', async () => {
    const hash = '$2y$10$yOpacZrf2R2.UDc8UuipSOt8XelQD7qITPRBqPvOzl/pSz6.AwO.q'

    expect(await Bun.password.verify('hunter2', hash.replace('$2y$', '$2b$'))).toBe(true)
  })
})
