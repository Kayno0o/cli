import { afterAll, expect, test } from 'bun:test'
import { publicIp } from '../src/ip'

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => new URL(request.url).pathname === '/plain' ? new Response('203.0.113.7\n') : new Response('no', { status: 500 }) })

afterAll(() => void server.stop(true))

test('reads the address the service answers', async () => {
  expect(await publicIp(undefined, `http://127.0.0.1:${server.port}/plain`)).toBe('203.0.113.7')
  expect(await publicIp(4, `http://127.0.0.1:${server.port}/plain`)).toBe('203.0.113.7')
})

test('throws when the service fails', async () => {
  let thrown = false

  try {
    await publicIp(undefined, `http://127.0.0.1:${server.port}/other`)
  }
  catch {
    thrown = true
  }

  expect(thrown).toBe(true)
})
