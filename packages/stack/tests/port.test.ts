import { capture } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { port } from '../src/commands/port'
import { stringToPort } from '../src/port'

// FNV-1a with BigInt, which never loses precision.
function fnv(name: string): number {
  let hash = 2166136261n

  for (const unit of name.split('').map(char => BigInt(char.charCodeAt(0))))
    hash = ((hash ^ unit) * 16777619n) & 0xFFFFFFFFn

  return Number(hash)
}

describe('stringToPort', () => {
  test.each([['a', 25900], ['bc', 5618], ['hello', 13483]])('%s hashes to %d with 32-bit FNV-1a', (name, expected) => {
    expect(stringToPort(name)).toBe(expected)
  })

  test('keeps long names exact, below the ephemeral range by default', () => {
    expect(stringToPort('a'.repeat(200))).toBe(1024 + (fnv('a'.repeat(200)) % 31744))

    for (const name of ['proxy-manager', 'inventory', 'a-rather-long-service-name-for-overflow'])
      expect(stringToPort(name)).toBeWithin(1024, 32768)
  })

  test('stays inside min and max', () => {
    for (const name of ['a', 'proxy-manager', 'inventory', 'é', ''])
      expect(stringToPort(name, 3000, 3010)).toBeWithin(3000, 3011)
  })
})

describe('stack port', () => {
  test('prints the number and keeps quiet when the port is free', async () => {
    const { result, out, err } = await capture(async () => port(['hello']))

    expect(result).toBe(0)
    expect(out).toBe('13483\n')
    expect(err).toBe('')
  })

  test('warns on stderr when something listens, and still exits 0', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } })

    try {
      const { result, out, err } = await capture(async () => port(['--min', String(server.port), '--max', String(server.port), 'anything']))

      expect(result).toBe(0)
      expect(out).toBe(`${server.port}\n`)
      expect(err).toContain(`port ${server.port} is already in use`)
    }
    finally {
      server.stop(true)
    }
  })

  test('a --min at or above the default ceiling alone spreads the names up to the highest port', async () => {
    const ports = await Promise.all(['api', 'web', 'db'].map(async name => Number((await capture(async () => port(['--min', '40000', name]))).out)))

    expect(new Set(ports).size).toBe(3)
    expect(ports.every(each => each >= 40000 && each <= 65535)).toBe(true)
  })

  test('needs a name and a sane range', async () => {
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(capture(async () => port([]))).rejects.toThrow('a name is needed')
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(capture(async () => port(['--min', '5000', '--max', '4000', 'x']))).rejects.toThrow('--max takes a whole number from 5000')
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(capture(async () => port(['--max', '99999', 'x']))).rejects.toThrow('--max goes up to 65535')
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(capture(async () => port(['--min', '0', 'x']))).rejects.toThrow('--min takes a whole number from 1024')
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(capture(async () => port(['--min', '70000', 'x']))).rejects.toThrow('--min goes up to 65535')
  })
})
