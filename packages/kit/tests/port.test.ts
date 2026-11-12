import { describe, expect, test } from 'bun:test'
import { isListening } from '../src/port'

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
