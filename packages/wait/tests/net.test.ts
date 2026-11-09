import { describe, expect, test } from 'bun:test'
import { waitforHarness } from './waitfor'

const { log, waitfor } = waitforHarness()

describe('waitfor --port and --url', () => {
  test('waits for a port to listen', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: socket => void socket.end() } })
    const port = server.port
    const result = await waitfor(['-p', String(port), '-t', '5s'])

    server.stop(true)
    expect(result.code).toBe(0)
    expect(result.out).toMatch(new RegExp(`^127\\.0\\.0\\.1:${port} listening after \\d+\\.\\ds\\n$`))
  })

  test('waits on the --host given, not 127.0.0.1', async () => {
    const server = Bun.listen({ hostname: '127.0.0.2', port: 0, socket: { data: socket => void socket.end() } })
    const port = server.port
    const result = await waitfor(['-p', String(port), '-H', '127.0.0.2', '-t', '5s'])

    server.stop(true)
    expect(result.code).toBe(0)
    expect(result.out).toStartWith(`127.0.0.2:${port} listening after`)
  })

  test('times out on a closed port, naming the error', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: socket => void socket.end() } })
    const port = server.port

    server.stop(true)

    const result = await waitfor(['-p', String(port), '-t', '500ms'])

    expect(result.code).toBe(2)
    expect(result.err).toContain(`127.0.0.1:${port} is not listening (ECONNREFUSED)`)
  })

  test('waits for a URL to answer 2xx, every condition together', async () => {
    let calls = 0
    const server = Bun.serve({ port: 0, fetch: () => new Response('', { status: ++calls < 3 ? 503 : 204 }) })
    const url = `http://127.0.0.1:${server.port}/health`
    const result = await waitfor(['--url', url, '-f', log('ready\n'), '-u', 'ready', '-p', String(server.port), '-t', '5s'])

    await server.stop(true)
    expect(result.code).toBe(0)
    expect(result.out).toContain(`${url} answered 204 after`)
    expect(result.out.split('\n')).toHaveLength(4)
  })

  test('times out on a URL answering an error, naming the status', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('', { status: 500 }) })
    // Long enough for a first answer on a loaded CI runner, where 500ms has run out before it.
    const result = await waitfor(['--url', `http://127.0.0.1:${server.port}/`, '-t', '2s'])

    await server.stop(true)
    expect(result.code).toBe(2)
    expect(result.err).toContain('answered 500')
  })
})

describe('waitfor --port without --host', () => {
  // A host with IPv6 loopback disabled cannot run this.
  test('counts a server bound to ::1 only', async () => {
    let server: ReturnType<typeof Bun.listen> | undefined

    try {
      server = Bun.listen({ hostname: '::1', port: 0, socket: { data: socket => void socket.end() } })
    }
    catch {
      return
    }

    const result = await waitfor(['-p', String(server.port), '-t', '5s'])

    server.stop(true)
    expect(result.code).toBe(0)
    expect(result.out).toStartWith(`[::1]:${server.port} listening after`)
  })
})
