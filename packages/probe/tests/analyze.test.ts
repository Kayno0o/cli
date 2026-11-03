import { describe, expect, test } from 'bun:test'
import { altSvcProtocols, cdnHint, certInfo, headersOf, httpRedirectOf, namesOf, nextUrl, offersOf, parseCurl, parseTarget, timingsOf, versionLabel, wantsHttpCheck, warningsOf, worthKnowing, WRITE_OUT } from '../src/analyze'

const SEPARATOR = '\n---HEADERS---\n'

describe('parseTarget', () => {
  test('a bare domain is https and flagged bare', () => {
    const target = parseTarget('example.com/a')

    expect(target?.bare).toBe(true)
    expect(target?.url.href).toBe('https://example.com/a')
    expect(parseTarget('localhost:8443')?.url.href).toBe('https://localhost:8443/')
  })

  test('a scheme is kept and anything else is refused', () => {
    expect(parseTarget('http://a.test')).toMatchObject({ bare: false })
    expect(parseTarget('ftp://a.test')).toBeUndefined()
    expect(parseTarget('')).toBeUndefined()
  })

  test('the http twin is checked for https on the default port only', () => {
    expect(wantsHttpCheck(parseTarget('a.test')!)).toBe(true)
    expect(wantsHttpCheck(parseTarget('https://a.test:8443')!)).toBe(false)
    expect(wantsHttpCheck(parseTarget('http://a.test')!)).toBe(false)
  })
})

describe('parseCurl', () => {
  const info = { exitcode: 0, errormsg: null, response_code: 301, http_version: '2', url_effective: 'https://a.test/', redirect_url: 'https://www.a.test/', remote_ip: '1.2.3.4', time_namelookup: 0.01, time_connect: 0.03, time_appconnect: 0.08, time_starttransfer: 0.12, time_total: 0.13 }

  test('reads status, version, location and header names lowercased', () => {
    const { hop } = parseCurl(`${JSON.stringify(info)}${SEPARATOR}{"Server":["nginx"],"Set-Cookie":["a=1","b=2"]}`)

    expect(hop).toMatchObject({ status: 301, version: '2', url: 'https://a.test/', location: 'https://www.a.test/', remoteIp: '1.2.3.4', headers: { 'server': 'nginx', 'set-cookie': 'a=1, b=2' } })
  })

  test('the template asks for both documents', () => {
    expect(WRITE_OUT).toContain('%{json}')
    expect(WRITE_OUT).toContain('%{header_json}')
  })

  test('reports phases as gaps between curl cumulative times', () => {
    expect(timingsOf(info)).toEqual({ dns: 10, connect: 20, tls: 50, firstByte: 40, total: 130 })
    expect(timingsOf({ time_namelookup: 0.01, time_connect: 0.03, time_appconnect: 0, time_starttransfer: 0.05, time_total: 0.06 })).toEqual({ dns: 10, connect: 20, tls: 0, firstByte: 20, total: 60 })
  })

  test('a failure carries curl exit code and message', () => {
    expect(parseCurl(JSON.stringify({ exitcode: 7, errormsg: 'Could not connect', response_code: 0 }))).toEqual({ exitcode: 7, errormsg: 'Could not connect' })
    expect(parseCurl('garbage').hop).toBeUndefined()
  })

  test('tolerates broken header json', () => {
    expect(headersOf('nope')).toEqual({})
  })
})

describe('redirects', () => {
  test('resolves relative locations and refuses other schemes', () => {
    expect(nextUrl('https://a.test/x', '/y')).toBe('https://a.test/y')
    expect(nextUrl('http://a.test/', 'https://a.test/')).toBe('https://a.test/')
    expect(nextUrl('http://a.test/', 'mailto:x@a.test')).toBeUndefined()
  })

  test('tells a redirect to https from anything else', () => {
    const hop = (status: number, location?: string) => ({ url: 'http://a.test/', status, version: '1.1', timings: timingsOf({}), headers: {}, ...(location === undefined ? {} : { location }) })

    expect(httpRedirectOf(hop(301, 'https://a.test/'))).toEqual({ status: 301, location: 'https://a.test/', toHttps: true })
    expect(httpRedirectOf(hop(301, '/other'))?.toHttps).toBe(false)
    expect(httpRedirectOf(hop(200))).toEqual({ status: 200, toHttps: false })
    expect(httpRedirectOf(undefined)).toBeUndefined()
  })
})

describe('offers', () => {
  test('lists alt-svc protocols', () => {
    expect(altSvcProtocols('h3=":443"; ma=86400, h3-29=":443"; ma=86400, h2=":443"')).toEqual(['h3', 'h3-29', 'h2'])
    expect(altSvcProtocols('clear')).toEqual([])
    expect(altSvcProtocols(undefined)).toEqual([])
  })

  test('h2 from alpn or the response, h3 from curl or alt-svc', () => {
    expect(offersOf({ alpn: 'h2', version: '1.1', altSvc: undefined })).toEqual({ h2: true, h3: false, altSvc: [] })
    expect(offersOf({ alpn: 'http/1.1', version: '1.1', altSvc: 'h3=":443"' })).toEqual({ h2: false, h3: true, altSvc: ['h3'] })
    expect(offersOf({ version: '3', altSvc: undefined })).toMatchObject({ h2: true, h3: true })
    expect(versionLabel('1.1')).toBe('HTTP/1.1')
  })
})

describe('headers', () => {
  test('keeps only the ones worth knowing', () => {
    expect(worthKnowing({ 'server': 'nginx', 'date': 'x', 'content-type': 'text/html', 'strict-transport-security': 'max-age=1' })).toEqual({ 'server': 'nginx', 'content-type': 'text/html', 'strict-transport-security': 'max-age=1' })
  })

  test('guesses a cdn from the telling header first', () => {
    expect(cdnHint({ 'cf-ray': 'abc', 'server': 'nginx' })).toBe('Cloudflare (cf-ray)')
    expect(cdnHint({ 'x-served-by': 'cache-cdg20720-CDG' })).toBe('Fastly (x-served-by)')
    expect(cdnHint({ via: '1.1 varnish' })).toBe('1.1 varnish (via)')
    expect(cdnHint({ 'x-cache': 'HIT' })).toBe('HIT (x-cache)')
    expect(cdnHint({ server: 'AkamaiGHost' })).toBe('Akamai (server)')
    expect(cdnHint({ server: 'nginx' })).toBeUndefined()
  })
})

describe('certificate', () => {
  const now = Date.parse('2026-11-03T00:00:00Z')
  const raw = { subject: { CN: 'a.test' }, issuer: { CN: 'R3', O: 'Lets' }, subjectaltname: 'DNS:a.test, DNS:*.a.test, IP Address:1.2.3.4', valid_from: 'Sep 1 00:00:00 2026 GMT', valid_to: 'Nov 13 00:00:00 2026 GMT' }

  test('counts days left and names issuer and names', () => {
    expect(certInfo(raw, now)).toEqual({ subject: 'a.test', issuer: 'R3 (Lets)', names: ['a.test', '*.a.test', '1.2.3.4'], validFrom: '2026-09-01T00:00:00.000Z', validTo: '2026-11-13T00:00:00.000Z', daysLeft: 10 })
    expect(certInfo({}, now)).toBeUndefined()
    expect(namesOf(undefined)).toEqual([])
  })
})

describe('warnings', () => {
  const cert = (daysLeft: number) => ({ subject: '', issuer: '', names: [], validFrom: '', validTo: '', daysLeft })

  test('warns under 14 days and when expired, not at 14', () => {
    expect(warningsOf({ cert: cert(13), tooManyRedirects: false })).toEqual(['certificate expires in 13 days'])
    expect(warningsOf({ cert: cert(14), tooManyRedirects: false })).toEqual([])
    expect(warningsOf({ cert: cert(-2), tooManyRedirects: false })).toEqual(['certificate expired 2 days ago'])
  })

  test('warns on an http twin that does not redirect to https', () => {
    expect(warningsOf({ httpRedirect: { status: 200, toHttps: false }, tooManyRedirects: false })).toEqual(['http:// answers 200 and does not redirect to https'])
    expect(warningsOf({ httpRedirect: { status: 301, toHttps: true }, tooManyRedirects: false })).toEqual([])
  })

  test('warns on an untrusted certificate and a redirect loop', () => {
    expect(warningsOf({ authorizationError: 'self signed certificate', tooManyRedirects: true })).toEqual(['certificate not trusted: self signed certificate', 'more than 10 redirects'])
  })
})
