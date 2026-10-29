import { capture } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { port } from '../src/commands/port'
import { isListening, stringToPort } from '../src/port'

describe('stringToPort', () => {
  // Printed by ~/zshrc/scripts/port.ts before it moved here.
  test.each([['a', 54572], ['bc', 24453], ['hello', 9377]])('%s hashes to %d like the old script', (name, expected) => {
    expect(stringToPort(name)).toBe(expected)
  })

  test('stays inside min and max', () => {
    for (const name of ['a', 'proxy-manager', 'c14', 'é', ''])
      expect(stringToPort(name, 3000, 3010)).toBeWithin(3000, 3011)
  })
})

describe('isListening', () => {
  test('sees a bound port and a free one', () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } })

    try {
      expect(isListening(server.port)).toBe(true)
    }
    finally {
      server.stop(true)
    }

    expect(isListening(server.port)).toBe(false)
  })
})

describe('stack port', () => {
  test('prints the number and keeps quiet when the port is free', async () => {
    const { result, out, err } = await capture(async () => port(['hello']))

    expect(result).toBe(0)
    expect(out).toBe('9377\n')
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

  test('needs a name and a sane range', async () => {
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(capture(async () => port([]))).rejects.toThrow('a name is needed')
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(capture(async () => port(['--min', '5000', '--max', '4000', 'x']))).rejects.toThrow('--max takes a whole number from 5000')
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(capture(async () => port(['--max', '99999', 'x']))).rejects.toThrow('--max goes up to 65535')
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(capture(async () => port(['--min', '0', 'x']))).rejects.toThrow('--min takes a whole number from 1')
  })
})
