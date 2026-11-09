import { describe, expect, test } from 'bun:test'
import { parseStatus } from '../src/conditions'
import { waitforHarness } from './waitfor'

const { waitfor } = waitforHarness()

const listener = () => Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: socket => void socket.end() } })

describe('repeated --port and --url', () => {
  test('waits for every one, naming each and when it came true in --json', async () => {
    const [one, two] = [listener(), listener()]
    const web = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    const url = `http://127.0.0.1:${web.port}/`
    const result = await waitfor(['-p', String(one.port), '-p', String(two.port), '--url', url, '--url', `${url}x`, '--json', '-t', '5s'])

    one.stop(true)
    two.stop(true)
    await web.stop(true)
    expect(result.code).toBe(0)

    const { conditions } = JSON.parse(result.out) as { conditions: { name: string, ms: number }[] }

    expect(conditions.map(item => item.name).toSorted()).toEqual([`127.0.0.1:${one.port}`, `127.0.0.1:${two.port}`, url, `${url}x`].toSorted())
    expect(conditions.every(item => item.ms >= 0)).toBe(true)
  })

  test('a timeout names the ones still pending only', async () => {
    const up = listener()
    const down = listener()
    const closed = down.port

    down.stop(true)

    const result = await waitfor(['-p', String(up.port), '-p', String(closed), '-t', '1s'])

    up.stop(true)
    expect(result.code).toBe(2)
    expect(result.err).toContain(`127.0.0.1:${closed} is not listening`)
    expect(result.err).not.toContain(`127.0.0.1:${up.port} is not listening`)
  })
})

describe('--status and --body', () => {
  test('parseStatus reads classes, ranges, codes and lists', () => {
    expect(parseStatus('2xx')?.(204)).toBe(true)
    expect(parseStatus('2xx')?.(301)).toBe(false)
    expect(parseStatus('200-299')?.(299)).toBe(true)
    expect(parseStatus('301')?.(302)).toBe(false)
    expect(parseStatus('404,5xx')?.(503)).toBe(true)
    expect(parseStatus('ok')).toBeUndefined()
  })

  test('waits for the status asked, not 2xx', async () => {
    const web = Bun.serve({ port: 0, fetch: () => new Response('', { status: 404 }) })
    const url = `http://127.0.0.1:${web.port}/`
    const wanted = await waitfor(['--url', url, '--status', '404', '-t', '5s'])
    const other = await waitfor(['--url', url, '-t', '1s'])

    await web.stop(true)
    expect(wanted.code).toBe(0)
    expect(wanted.out).toContain('answered 404')
    expect(other.code).toBe(2)
  })

  test('sees a redirect itself when a 3xx is asked', async () => {
    const web = Bun.serve({ port: 0, fetch: () => new Response('', { status: 301, headers: { location: 'http://127.0.0.1:1/' } }) })
    const result = await waitfor(['--url', `http://127.0.0.1:${web.port}/`, '--status', '301', '-t', '5s'])

    await web.stop(true)
    expect(result.code).toBe(0)
  })

  test('waits for the body to match', async () => {
    let calls = 0
    const web = Bun.serve({ port: 0, fetch: () => new Response(++calls < 3 ? 'starting' : '{"status":"ready"}') })
    const result = await waitfor(['--url', `http://127.0.0.1:${web.port}/`, '--body', '"status":"ready"', '-t', '5s'])

    await web.stop(true)
    expect(result.code).toBe(0)
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test('a body that never matches times out saying so', async () => {
    const web = Bun.serve({ port: 0, fetch: () => new Response('nope') })
    const result = await waitfor(['--url', `http://127.0.0.1:${web.port}/`, '--body', 'ready', '-t', '1s'])

    await web.stop(true)
    expect(result.code).toBe(2)
    expect(result.err).toContain('body does not match')
  })

  test('refuses --status without --url and a bad status', async () => {
    expect((await waitfor(['-p', '1', '--status', '200'])).err).toContain('--status and --body go with --url')
    expect((await waitfor(['--url', 'http://x/', '--status', 'bad'])).err).toContain('--status takes')
  })
})
