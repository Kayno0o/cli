import { afterAll, describe, expect, test } from 'bun:test'
import { addressesOf, curlHop, tlsInfo } from '../src/net'

const seen: string[] = []
const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    seen.push(request.method)
    const { pathname } = new URL(request.url)

    if (pathname === '/no-head' && request.method === 'HEAD')
      return new Response(null, { status: 405 })

    if (pathname === '/forbidden-head' && request.method === 'HEAD')
      return new Response(null, { status: 403 })

    if (pathname === '/not-implemented' && request.method === 'HEAD')
      return new Response(null, { status: 501 })

    return new Response('ok', { status: 200 })
  },
})
const base = `http://127.0.0.1:${server.port}`
const hop = { http3: false, insecure: false, get: false }

afterAll(async () => server.stop(true))

describe('addressesOf', () => {
  test('takes an IP literal as it is, without a lookup', async () => {
    expect(await addressesOf('192.0.2.7')).toEqual({ a: ['192.0.2.7'], aaaa: [] })
    expect(await addressesOf('2001:db8::1')).toEqual({ a: [], aaaa: ['2001:db8::1'] })
  })

  test('strips the brackets of an IPv6 host', async () => {
    expect(await addressesOf('[2001:db8::1]')).toEqual({ a: [], aaaa: ['2001:db8::1'] })
  })

  test('answers empty for a name that does not resolve', async () => {
    expect(await addressesOf('nothing.invalid')).toEqual({ a: [], aaaa: [] })
  })
})

describe('curlHop', () => {
  test('reads the status of one request without following anything', async () => {
    const result = await curlHop(`${base}/`, hop)

    expect(result.hop?.status).toBe(200)
  })

  test('asks again with GET when HEAD is answered 405 or 501', async () => {
    seen.length = 0
    expect((await curlHop(`${base}/no-head`, hop)).hop?.status).toBe(200)
    expect((await curlHop(`${base}/not-implemented`, hop)).hop?.status).toBe(200)
    expect(seen).toEqual(['HEAD', 'GET', 'HEAD', 'GET'])
  })

  test('asks again with GET when HEAD is answered with any error status', async () => {
    seen.length = 0
    expect((await curlHop(`${base}/forbidden-head`, hop)).hop?.status).toBe(200)
    expect(seen).toEqual(['HEAD', 'GET'])
  })

  test('does not retry when GET was asked from the start', async () => {
    seen.length = 0
    await curlHop(`${base}/no-head`, { ...hop, get: true })
    expect(seen).toEqual(['GET'])
  })

  test('carries the curl failure when nothing listens', async () => {
    const free = Bun.serve({ port: 0, fetch: () => new Response('') })
    const port = free.port

    await free.stop(true)

    const result = await curlHop(`http://127.0.0.1:${port}/`, hop)

    expect(result.hop).toBeUndefined()
    expect(result.exitcode).toBeGreaterThan(0)
  })
})

describe('tlsInfo', () => {
  test('is undefined when the port does not speak TLS or refuses', async () => {
    expect(await tlsInfo('127.0.0.1', server.port!)).toBeUndefined()
  })
})
