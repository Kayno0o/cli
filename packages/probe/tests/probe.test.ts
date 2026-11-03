import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { afterAll, describe, expect, test } from 'bun:test'

const CLI = new URL('../src/probe.ts', import.meta.url).pathname
const temp = tempDirs()

async function probe(args: string[]) {
  const child = Bun.spawn([process.execPath, CLI, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, out, err }
}

interface Json {
  status: number
  url: string
  chain: { status: number }[]
  addresses: unknown
  tls: { protocol: string } | null
  certificate: { names: string[], daysLeft: number } | null
  headers: Record<string, string>
  warnings: string[]
}

function parsed(out: string): Json {
  return JSON.parse(out) as Json
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const { pathname } = new URL(request.url)

    if (pathname === '/old')
      return new Response(null, { status: 301, headers: { location: '/mid' } })

    if (pathname === '/mid')
      return new Response(null, { status: 302, headers: { location: '/final' } })

    if (pathname === '/loop')
      return new Response(null, { status: 302, headers: { location: '/loop' } })

    if (pathname === '/nohead' && request.method === 'HEAD')
      return new Response(null, { status: 405 })

    return new Response('hello', { headers: { 'content-type': 'text/plain', 'cache-control': 'max-age=60', 'alt-svc': 'h3=":443"; ma=60', 'via': '1.1 testproxy' } })
  },
})

afterAll(async () => server.stop(true))

const base = `http://127.0.0.1:${server.port}`

describe('probe against a local http server', () => {
  test('follows redirects hop by hop and reports the final answer', async () => {
    const { code, out } = await probe([`${base}/old`, '--json'])
    const report = parsed(out)

    expect(code).toBe(0)
    expect(report.chain.map((hop: { status: number }) => hop.status)).toEqual([301, 302, 200])
    expect(report).toMatchObject({ status: 200, version: '1.1', url: `${base}/final`, tls: null, certificate: null, cdn: '1.1 testproxy (via)', offers: { h2: false, h3: true, altSvc: ['h3'] }, headers: { 'content-type': 'text/plain', 'cache-control': 'max-age=60' } })
    expect(report.addresses).toEqual({ a: ['127.0.0.1'], aaaa: [] })
    expect(report.warnings).toEqual(['the site is not served over https'])
  })

  test('prints the chain, timings and a warning in text', async () => {
    const { code, out, err } = await probe([`${base}/old`])

    expect(code).toBe(0)
    expect(out).toStartWith(`HTTP/1.1 200 ${base}/final`)
    expect(out).toMatch(/301\s+HTTP\/1\.1/)
    expect(out).toMatch(/timings\s+dns \d+ms, connect \d+ms, tls 0ms, first byte \d+ms, total \d+ms/)
    expect(out).toContain('offers        h2 no, h3 yes (alt-svc h3)')
    expect(out).toContain('warning: the site is not served over https')
    expect(err).toBe('')
  })

  test('retries with GET when HEAD is refused', async () => {
    const report = parsed((await probe([`${base}/nohead`, '--json'])).out)

    expect(report.status).toBe(200)
  })

  test('stops a redirect loop and warns', async () => {
    const report = parsed((await probe([`${base}/loop`, '--json'])).out)

    expect(report.chain).toHaveLength(10)
    expect(report.warnings).toContain('more than 10 redirects')
  })

  test('a bare domain falls back to http when https is not served', async () => {
    const report = parsed((await probe([`127.0.0.1:${server.port}/final`, '--json'])).out)

    expect(report.url).toBe(`${base}/final`)
    expect(report.tls).toBeNull()
  })

  test('exits 1 when nothing answers and 2 on bad input', async () => {
    expect((await probe(['http://127.0.0.1:1/'])).code).toBe(1)
    expect((await probe(['ftp://a.test'])).code).toBe(2)
    expect((await probe([])).code).toBe(2)
  })
})

const openssl = Bun.which('openssl')

describe.skipIf(openssl === null)('probe against a local tls server', () => {
  const dir = temp('probe-')
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')

  Bun.spawnSync([openssl ?? 'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '5', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdout: 'ignore', stderr: 'ignore' })

  const secure = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: { key: Bun.file(key), cert: Bun.file(cert) }, fetch: () => new Response('ok', { headers: { 'strict-transport-security': 'max-age=1', 'server': 'bun-test' } }) })

  afterAll(async () => secure.stop(true))

  test('reads the certificate and warns that it expires soon and is not trusted', async () => {
    const { code, out } = await probe([`https://localhost:${secure.port}/`, '--insecure', '--json'])
    const report = parsed(out)

    expect(code).toBe(0)
    expect(report.status).toBe(200)
    expect(report.tls?.protocol).toBe('TLSv1.3')
    expect(report.certificate?.names).toEqual(['localhost', '127.0.0.1'])
    expect(report.certificate?.daysLeft).toBeGreaterThanOrEqual(4)
    expect(report.certificate?.daysLeft).toBeLessThanOrEqual(5)
    expect(report.headers['strict-transport-security']).toBe('max-age=1')
    expect(report.warnings.some((line: string) => line.startsWith('certificate expires in'))).toBe(true)
    expect(report.warnings.some((line: string) => line.startsWith('certificate not trusted'))).toBe(true)
  })

  test('without --insecure curl refuses the certificate and probe exits 1', async () => {
    expect((await probe([`https://localhost:${secure.port}/`])).code).toBe(1)
  })
})
