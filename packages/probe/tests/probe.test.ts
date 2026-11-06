import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

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
  async fetch(request) {
    const { pathname } = new URL(request.url)

    if (pathname === '/old')
      return new Response(null, { status: 301, headers: { location: '/mid' } })

    if (pathname === '/mid')
      return new Response(null, { status: 302, headers: { location: '/final' } })

    if (pathname === '/loop')
      return new Response(null, { status: 302, headers: { location: '/loop' } })

    if (pathname === '/seen')
      return new Response('x', { headers: { server: `${request.headers.get('x-probe') ?? 'none'} at ${request.headers.get('host')}` } })

    if (pathname === '/slow') {
      await Bun.sleep(1500)

      return new Response('late')
    }

    // Allows https://app.test to PUT with content-type, when the preflight asks the way a browser does.
    if (pathname === '/cors' && request.method === 'OPTIONS') {
      const origin = request.headers.get('origin')
      const asked = request.headers.get('access-control-request-method') !== null

      return new Response(null, { status: 204, headers: origin === 'https://app.test' && asked ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, PUT', 'access-control-allow-headers': 'content-type', 'vary': 'Origin' } : {} })
    }

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
    const { code, out, err } = await probe([`${base}/old`, '--verbose'])

    expect(code).toBe(0)
    expect(out).toStartWith(`HTTP/1.1 200 ${base}/final`)
    expect(out).toMatch(/301\s+HTTP\/1\.1/)
    expect(out).toMatch(/timings\s+dns \d+ms, connect \d+ms, tls 0ms, first byte \d+ms, total \d+ms/)
    expect(out).toContain('offers        h2 no, h3 yes (alt-svc h3)')
    expect(out).toContain('warning: the site is not served over https')
    expect(err).toBe('')
  })

  test('prints one line by default', async () => {
    const { code, out } = await probe([`${base}/old`])

    expect(code).toBe(0)
    expect(out.trimEnd().split('\n')).toHaveLength(1)
    expect(out).toMatch(new RegExp(`^HTTP/1\\.1 200 ${base}/final\\s+\\d+ms\\s+2 redirects\\s+127\\.0\\.0\\.1\\s+warning: the site is not served over https\\n$`))
  })

  test('probes several targets, one line each, exiting 1 when one cannot be reached', async () => {
    const both = await probe([`${base}/final`, `${base}/old`])

    expect(both.code).toBe(0)
    expect(both.out.trimEnd().split('\n')).toHaveLength(2)

    const mixed = await probe([`${base}/final`, 'http://127.0.0.1:1/'])

    expect(mixed.code).toBe(1)
    expect(mixed.out.trimEnd().split('\n')).toHaveLength(1)
    expect(mixed.err).toContain('could not reach 127.0.0.1:1')
  })

  test('--json is the same object for one target and an array for several, an unreachable one being {target, error}', async () => {
    const one = parsed((await probe([`${base}/final`, '--json'])).out)
    const several = JSON.parse((await probe([`${base}/final`, 'http://127.0.0.1:1/', '--json'])).out) as [Json, { target: string, error: string }]

    expect(one.status).toBe(200)
    expect(several[0].status).toBe(200)
    expect(several[1]).toMatchObject({ target: 'http://127.0.0.1:1/', error: expect.stringContaining('could not reach') })
  })

  test('-H sends a header with every request', async () => {
    const report = parsed((await probe([`${base}/seen`, '-H', 'X-Probe: yes', '--json'])).out)

    expect(report.headers.server).toStartWith('yes at')
    expect((await probe([`${base}/seen`, '-H', 'no colon'])).code).toBe(2)
  })

  test('--resolve reaches a host at the address given, keeping the Host header', async () => {
    const target = `http://my.test:${server.port}/seen`
    const report = parsed((await probe([target, '--resolve', 'my.test:127.0.0.1', '--json'])).out)

    expect(report.headers.server).toBe(`none at my.test:${server.port}`)
    expect(report.addresses).toEqual({ a: ['127.0.0.1'], aaaa: [] })
    expect((await probe([target, '--resolve', 'my.test'])).code).toBe(2)
    expect((await probe([target, '--resolve', 'my.test:nope'])).code).toBe(2)
  })

  test('--cors says whether the preflight lets the request through, exiting 1 when it does not', async () => {
    const allowed = await probe([`${base}/cors`, '--cors', 'https://app.test/', '--method', 'put'])

    expect(allowed.code).toBe(0)
    expect(allowed.out).toStartWith(`ok: allowed 204 ${base}/cors  from https://app.test, PUT with content-type`)
    expect(allowed.out).toContain('  access-control-allow-methods GET, PUT')

    const refused = await probe([`${base}/cors`, '--cors', 'https://evil.test', '--json'])

    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.out)).toEqual({ target: `${base}/cors`, url: `${base}/cors`, status: 204, request: { origin: 'https://evil.test', method: 'POST', headers: ['content-type'] }, allowed: false, reasons: ['no access-control-allow-origin', 'access-control-allow-headers does not cover content-type'], warnings: [], headers: {} })

    const header = await probe([`${base}/cors`, '--cors', 'https://app.test', '--cors-headers', 'content-type, x-trace', '--json'])

    expect((JSON.parse(header.out) as { reasons: string[] }).reasons).toEqual(['access-control-allow-headers does not cover x-trace'])
    expect((await probe(['http://127.0.0.1:1/', '--cors', 'https://app.test'])).code).toBe(1)
  })

  test('--cors, --method and --dns refuse what they cannot go with', async () => {
    expect((await probe([base, '--cors', 'not an origin'])).code).toBe(2)
    expect((await probe([base, '--method', 'PUT'])).err).toContain('--method goes with --cors')
    expect((await probe([base, '--cors-headers', 'x'])).code).toBe(2)
    expect((await probe([base, '--dns', '-H', 'X: 1'])).err).toContain('--dns cannot be used with --header')
    expect((await probe(['127.0.0.1', '--dns'])).err).toContain('--dns takes a name, not the address 127.0.0.1')
  })

  test('--timeout gives up on a slow answer', async () => {
    expect((await probe([`${base}/slow`, '-t', '300ms'])).code).toBe(1)
    expect((await probe([`${base}/slow`, '-t', '10s'])).code).toBe(0)
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

  // A skipped describe still runs its body, so the certificate and the server wait for a hook that a skip does not run.
  let secure: ReturnType<typeof Bun.serve>

  beforeAll(() => {
    Bun.spawnSync([openssl ?? 'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '5', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdout: 'ignore', stderr: 'ignore' })
    secure = Bun.serve({ port: 0, hostname: '127.0.0.1', tls: { key: Bun.file(key), cert: Bun.file(cert) }, fetch: () => new Response('ok', { headers: { 'strict-transport-security': 'max-age=1', 'server': 'bun-test' } }) })
  })

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
