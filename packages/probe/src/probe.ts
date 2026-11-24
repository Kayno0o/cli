#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { CertInfo, Headers, Hop, HttpRedirect, Offers, SecurityAudit, Target, Timings } from './analyze'
import type { CorsRequest, CorsVerdict } from './cors'
import type { DnsReport, RecordType, TypedRecords } from './dns'
import type { Addresses, TlsInfo, Wire } from './net'
import { isIP } from 'node:net'
import process from 'node:process'
import { badUsage, duration, fail, jsonOption, marked, paint, parse, printJson, role, runCli, table } from '@kaynooo/cli-kit'
import { cdnHint, daysLeftLabel, httpRedirectOf, isRedirect, MAX_HOPS, nextUrl, offersOf, parseTarget, securityAudit, versionLabel, wantsHttpCheck, warningsOf, worthKnowing } from './analyze'
import { corsVerdict, methodOf, originOf, requestedHeaders } from './cors'
import { dnsReport, known, network, queryRecordTypes, RECORD_TYPES } from './dns'
import { publicIp } from './ip'
import { addressesOf, curlHasHttp3, curlHop, curlPreflight, portOf, tlsInfo } from './net'

const LABEL_WIDTH = 13

const HTTP_USAGE = `probe [http] [options] <url|domain>...: reports each site's HTTP version, redirect chain, timings, addresses, TLS, certificate, headers, security headers and warnings

A single target prints the full summary by default (--compact forces one line); multiple targets print one line each (--verbose forces full summaries).
A bare domain is tried over https first, then http, following up to ${MAX_HOPS} redirects.`

const HTTP_EXITS: ExitRow[] = [[0, 'every site answered, warnings or not'], [1, 'a site could not be reached or redirects where nothing answers'], [2, 'a usage error']]

const HTTP_OPTIONS = {
  'insecure': { type: 'boolean', short: 'k', description: 'let curl go on with a certificate it does not trust' },
  'header': { type: 'string', short: 'H', multiple: true, description: 'a `Name: value` header sent with every request, repeatable' },
  'resolve': { type: 'string', multiple: true, description: 'host:ip, reach the host at that address instead of the DNS answer, repeatable' },
  'timeout': { type: 'string', short: 't', description: 'longest one request may take (20s): 5s, 1m, a bare number in seconds' },
  'verbose': { type: 'boolean', description: 'print the full table for every target (default for a single target)' },
  'compact': { type: 'boolean', description: 'print one line per target (default for multiple targets)' },
  'all-headers': { type: 'boolean', description: 'include all response headers, not just the notable ones' },
  'json': jsonOption('one object per target {target, url, version, status, chain, timings, addresses, tls, certificate, headers, securityHeaders, cdn, offers, httpRedirect, failedHop, warnings}, or an array for several'),
} as const

const DNS_USAGE = `probe dns [options] <domain>...: compares DNS answers across system, public and authoritative resolvers, or queries specific record types (-t MX,TXT,CAA,NS,SOA)`
const DNS_EXITS: ExitRow[] = [[0, 'every domain resolved'], [1, 'no resolver found records for a domain'], [2, 'a usage error']]
const DNS_OPTIONS = {
  type: { type: 'string', short: 't', description: `record types to query, comma separated: ${RECORD_TYPES.join(', ')}` },
  timeout: { type: 'string', description: 'per-query timeout (3s): 5s, 500ms, a bare number in seconds' },
  json: jsonOption('resolver comparison report (with records when -t is passed)'),
} as const

const CORS_USAGE = `probe cors [options] <origin> <url>...: sends a browser CORS preflight and reports whether the request would be allowed, and why not`
const CORS_EXITS: ExitRow[] = [[0, 'preflight allowed for every target'], [1, 'preflight refused or target unreachable'], [2, 'a usage error']]
const CORS_OPTIONS = {
  'method': { type: 'string', short: 'm', description: 'Access-Control-Request-Method (POST)' },
  'cors-headers': { type: 'string', description: 'Access-Control-Request-Headers, comma separated, empty for none (content-type)' },
  'header': { type: 'string', short: 'H', multiple: true, description: 'extra `Name: value` request header, repeatable' },
  'resolve': { type: 'string', multiple: true, description: 'host:ip override, repeatable' },
  'insecure': { type: 'boolean', short: 'k', description: 'ignore untrusted TLS certificates' },
  'timeout': { type: 'string', short: 't', description: 'request timeout (20s)' },
  'json': jsonOption('{target, url, status, request, allowed, reasons, warnings, headers}'),
} as const

const TLS_USAGE = `probe tls [options] <host[:port]|url>...: inspects TLS protocol, cipher, ALPN and certificate directly without sending an HTTP request`
const TLS_EXITS: ExitRow[] = [[0, 'TLS handshake succeeded'], [1, 'could not complete TLS handshake'], [2, 'a usage error']]
const TLS_OPTIONS = {
  resolve: { type: 'string', multiple: true, description: 'host:ip override, repeatable' },
  timeout: { type: 'string', short: 't', description: 'handshake timeout (10s)' },
  json: jsonOption('{target, host, port, protocol, cipher, alpn, certificate, authorizationError, warnings}'),
} as const

const IP_USAGE = `probe ip [-4|-6] [--json]: prints this machine's public IP address`
const IP_EXITS: ExitRow[] = [[0, 'printed public IP'], [1, 'could not reach IP service'], [2, 'a usage error']]
const IP_OPTIONS = {
  4: { type: 'boolean', description: 'IPv4 address only' },
  6: { type: 'boolean', description: 'IPv6 address only' },
  json: jsonOption('{ip}'),
} as const

const BRACKETS = /^\[|\]$/g
const HEADER_LINE = /^[\w!#$%&'*+.^`|~-]+:/

interface Report {
  target: string
  url: string
  version: string
  status: number
  chain: { url: string, status: number, version: string, location?: string, ms: number }[]
  timings: Timings
  addresses: Addresses
  tls: { protocol: string, cipher: string, alpn?: string } | null
  certificate: CertInfo | null
  headers: Headers
  securityHeaders: SecurityAudit
  cdn: string | null
  offers: Offers
  httpRedirect: HttpRedirect | null
  failedHop: { url: string, error: string } | null
  warnings: string[]
}

interface Followed {
  chain: Hop[]
  failed?: { url: string, error: string }
  tooMany: boolean
}

interface Settings {
  insecure: boolean
  wire: Wire
  allHeaders: boolean
}

async function follow(start: string, { insecure, wire }: Pick<Settings, 'insecure' | 'wire'>, http3: boolean): Promise<Followed> {
  const chain: Hop[] = []
  let url = start

  while (chain.length <= MAX_HOPS) {
    const { hop, errormsg } = await curlHop(url, { ...wire, http3: http3 && url.startsWith('https:'), insecure, get: false })

    if (hop === undefined)
      return { chain, failed: { url, error: errormsg ?? 'no response' }, tooMany: false }

    chain.push(hop)

    const next = hop.location === undefined ? undefined : nextUrl(hop.url, hop.location)

    if (!isRedirect(hop.status) || next === undefined)
      return { chain, tooMany: false }

    url = next
  }

  return { chain, tooMany: true }
}

async function probeOne(target: Target, input: string, settings: Settings): Promise<Report | { target: string, error: string }> {
  const { wire } = settings
  const http3 = await curlHasHttp3()
  let followed = await follow(target.url.href, settings, http3)
  let httpsError: string | undefined

  if (followed.chain.length === 0 && target.bare) {
    const plain = new URL(target.url.href)

    plain.protocol = 'http:'

    const second = await follow(plain.href, settings, http3)

    if (second.chain.length > 0) {
      httpsError = followed.failed?.error
      followed = second
    }
  }

  const final = followed.chain.at(-1)

  if (final === undefined)
    return { target: input, error: `could not reach ${target.url.host}: ${followed.failed?.error ?? 'no response'}` }

  const finalUrl = new URL(final.url)
  const secure = finalUrl.protocol === 'https:'
  const [addresses, tls, twin] = await Promise.all([
    addressesOf(target.url.hostname, wire.resolve),
    secure ? tlsInfo(finalUrl.hostname, portOf(finalUrl), { address: wire.resolve?.get(finalUrl.hostname), ...(wire.timeoutS === undefined ? {} : { timeoutS: wire.timeoutS }) }) : Promise.resolve(undefined as TlsInfo | undefined),
    wantsHttpCheck(target) && secure ? twinOf(target.url, settings) : Promise.resolve(undefined),
  ])
  const httpRedirect = httpRedirectOf(twin)
  const offers = offersOf({ alpn: tls?.alpn, version: final.version, altSvc: final.headers['alt-svc'] })
  const warnings = warningsOf({ cert: tls?.cert, authorizationError: tls?.authorizationError, httpRedirect, tooManyRedirects: followed.tooMany })

  if (followed.failed !== undefined)
    warnings.unshift(`the redirect to ${followed.failed.url} got no answer: ${followed.failed.error}`)

  if (!secure)
    warnings.push(httpsError === undefined ? 'the site is not served over https' : `the site is not served over https: ${httpsError}`)

  return {
    target: input,
    url: final.url,
    version: final.version,
    status: final.status,
    chain: followed.chain.map(hop => ({ url: hop.url, status: hop.status, version: hop.version, ...(hop.location === undefined ? {} : { location: hop.location }), ms: hop.timings.total })),
    timings: final.timings,
    addresses,
    tls: tls === undefined ? null : { protocol: tls.protocol, cipher: tls.cipher, ...(tls.alpn === undefined ? {} : { alpn: tls.alpn }) },
    certificate: tls?.cert ?? null,
    headers: settings.allHeaders ? final.headers : worthKnowing(final.headers),
    securityHeaders: securityAudit(final.headers, secure),
    cdn: cdnHint(final.headers) ?? null,
    offers,
    httpRedirect: httpRedirect ?? null,
    failedHop: followed.failed ?? null,
    warnings,
  }
}

const unreached = (report: Report | { error: string }) => 'error' in report || report.failedHop !== null

async function twinOf(url: URL, { insecure, wire }: Pick<Settings, 'insecure' | 'wire'>): Promise<Hop | undefined> {
  const plain = new URL(url.href)

  plain.protocol = 'http:'

  return (await curlHop(plain.href, { ...wire, http3: false, insecure, get: false })).hop
}

function resolvesOf(entries: readonly string[]): Map<string, string> {
  const resolve = new Map<string, string>()

  for (const entry of entries) {
    const at = entry.indexOf(':')
    const address = entry.slice(at + 1).replace(BRACKETS, '')

    if (at < 1 || isIP(address) === 0)
      badUsage(`--resolve takes host:ip, not ${entry}`)

    resolve.set(entry.slice(0, at).toLowerCase(), address)
  }

  return resolve
}

function validateHeaders(headers: readonly string[]): void {
  for (const header of headers) {
    if (!HEADER_LINE.test(header))
      badUsage(`-H takes "Name: value", not ${header}`)
  }
}

function ms(value: number): string {
  return `${value}ms`
}

function compact(report: Report): string {
  const { dim } = paint(process.stdout)
  const redirects = report.chain.length - 1
  const parts = [`${role('accent', process.stdout)(versionLabel(report.version))} ${role('value', process.stdout)(String(report.status))} ${role('path', process.stdout)(report.url)}`, ms(report.timings.total)]
  const address = report.addresses.a[0] ?? report.addresses.aaaa[0]

  if (redirects > 0)
    parts.push(`${redirects} ${redirects === 1 ? 'redirect' : 'redirects'}`)

  if (report.certificate !== null)
    parts.push(`cert ${daysLeftLabel(report.certificate.daysLeft)}`)

  if (address !== undefined)
    parts.push(address)

  const line = parts.join(dim('  '))

  return report.warnings.length === 0 ? line : `${line}  ${marked('warn', report.warnings.join('; '), process.stdout)}`
}

function print(report: Report): void {
  const label = role('label', process.stdout)
  const value = role('value', process.stdout)
  const accent = role('accent', process.stdout)
  const row = (name: string, text: string): void => console.log(`${label(name.padEnd(LABEL_WIDTH))} ${text}`)

  console.log(`${accent(versionLabel(report.version))} ${value(String(report.status))} ${role('path', process.stdout)(report.url)}`)
  console.log('')

  if (report.chain.length > 1) {
    console.log(table(report.chain.map(hop => [String(hop.status), versionLabel(hop.version), ms(hop.ms), hop.url]), { align: ['right', 'left', 'right', 'left'] }))
    console.log('')
  }

  const { timings } = report

  row('timings', `dns ${ms(timings.dns)}, connect ${ms(timings.connect)}, tls ${ms(timings.tls)}, first byte ${ms(timings.firstByte)}, total ${ms(timings.total)}`)
  row('addresses', [...report.addresses.a, ...report.addresses.aaaa].join(', ') || 'none found')

  if (report.tls !== null)
    row('tls', `${report.tls.protocol} ${report.tls.cipher}`)

  const cert = report.certificate

  if (cert !== null) {
    row('issuer', cert.issuer)
    row('expires', `${cert.validTo.slice(0, 10)} (${daysLeftLabel(cert.daysLeft)})`)
    row('names', cert.names.join(', '))
  }

  row('offers', `h2 ${report.offers.h2 ? 'yes' : 'no'}, h3 ${report.offers.h3 ? 'yes' : 'no'}${report.offers.altSvc.length === 0 ? '' : ` (alt-svc ${report.offers.altSvc.join(' ')})`}`)

  for (const [name, text] of Object.entries(report.headers))
    row(name === 'strict-transport-security' ? 'hsts' : name, text)

  if (report.securityHeaders.missing.length > 0)
    row('security', `missing ${report.securityHeaders.missing.join(', ')}`)
  else
    row('security', 'all key headers present')

  if (report.cdn !== null)
    row('cdn', report.cdn)

  if (report.httpRedirect !== null)
    row('http://', report.httpRedirect.toHttps ? `redirects to https (${report.httpRedirect.status})` : `answers ${report.httpRedirect.status}`)

  for (const warning of report.warnings)
    console.log(marked('warn', warning, process.stdout))
}

async function httpCmd(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, HTTP_USAGE, HTTP_OPTIONS, {
    positionals: ['<url|domain>...'],
    exits: HTTP_EXITS,
    examples: ['probe example.com', ['probe a.test b.test', 'one line each'], ['probe https://example.com --all-headers', 'include every response header']],
  })

  if (values.verbose === true && values.compact === true)
    badUsage('pass either --verbose or --compact, not both')

  const headers = values.header ?? []

  validateHeaders(headers)

  const timeoutMs = values.timeout === undefined ? undefined : duration(values.timeout, 'timeout', 0, 's')
  const wire: Wire = { headers, resolve: resolvesOf(values.resolve ?? []), ...(timeoutMs === undefined ? {} : { timeoutS: timeoutMs / 1000 }) }
  const targets = positionals.map((input) => {
    const target = parseTarget(input)

    if (target === undefined)
      badUsage(`not a URL or domain: ${input}`)

    return { input, target }
  })
  const reports = await Promise.all(targets.map(async ({ input, target }) => probeOne(target, input, { insecure: values.insecure === true, wire, allHeaders: values['all-headers'] === true })))
  const [only] = reports

  if (reports.length === 1 && only !== undefined && 'error' in only)
    fail(only.error, 1)

  if (values.json === true) {
    printJson(reports.length === 1 ? only : reports)

    return reports.some(unreached) ? 1 : 0
  }

  const detailed = values.verbose === true || (values.compact !== true && reports.length === 1)
  let first = true

  for (const report of reports) {
    if ('error' in report) {
      console.error(marked('problem', report.error, process.stderr))
    }
    else if (detailed) {
      if (!first)
        console.log('')

      if (reports.length > 1)
        console.log(role('label', process.stdout)(report.target))

      print(report)
    }
    else {
      console.log(compact(report))
    }

    first = false
  }

  return reports.some(unreached) ? 1 : 0
}

function printDns(report: DnsReport, records?: TypedRecords[]): void {
  const label = role('label', process.stdout)
  const listed = (values: string[]): string => values.length === 0 ? '-' : values.join(' ')

  console.log(`${role('path', process.stdout)(report.target)}  ${label(report.zone === null ? 'no zone found' : `zone ${report.zone}`)}`)
  console.log(table([
    ['RESOLVER', 'SERVER', 'A', 'AAAA', 'CNAME', 'TTL'],
    ...report.answers.map(answer => [
      answer.authoritative ? `${answer.resolver} (ns)` : answer.resolver,
      answer.server,
      ...(answer.error === undefined ? [listed(answer.a), listed(answer.aaaa), listed(answer.cname)] : [answer.error, '', '']),
      answer.ttl === null ? '-' : `${answer.ttl}s`,
    ]),
  ], { header: true }))

  if (records !== undefined && records.length > 0) {
    console.log('')
    console.log(table([
      ['TYPE', 'VALUES'],
      ...records.map(entry => [entry.type, entry.error ?? (entry.values.length === 0 ? '-' : entry.values.join('; '))]),
    ], { header: true }))
  }

  if (report.agree)
    console.log(marked('ok', 'every resolver gives the same answer', process.stdout))

  for (const warning of report.warnings)
    console.log(marked('warn', warning, process.stdout))
}

async function dnsCmd(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, DNS_USAGE, DNS_OPTIONS, {
    positionals: ['<domain>...'],
    exits: DNS_EXITS,
    examples: ['probe dns example.com', ['probe dns -t MX,TXT,CAA example.com', 'query mail, TXT and CAA records']],
  })
  const timeoutMs = values.timeout === undefined ? undefined : duration(values.timeout, 'timeout', 0, 's')
  let types: RecordType[] | undefined

  if (values.type !== undefined) {
    const raw = values.type.split(',').map(item => item.trim().toUpperCase()).filter(Boolean)
    const unknown = raw.find(item => !(RECORD_TYPES as readonly string[]).includes(item))

    if (unknown !== undefined || raw.length === 0)
      badUsage(`--type takes ${RECORD_TYPES.join(', ')}, not ${values.type}`)

    types = raw as RecordType[]
  }

  const hosts = positionals.map((input) => {
    const host = parseTarget(input)?.url.hostname

    if (host === undefined)
      badUsage(`not a URL or domain: ${input}`)

    if (isIP(host.replace(BRACKETS, '')) !== 0)
      badUsage(`probe dns takes a name, not the address ${input}`)

    return { input, host }
  })

  if (types !== undefined) {
    const results = await Promise.all(hosts.map(async ({ input, host }) => ({ target: input, records: await queryRecordTypes(host, types, timeoutMs) })))

    if (values.json === true) {
      printJson(results.length === 1 ? results[0] : results)
    }
    else {
      for (const [at, result] of results.entries()) {
        if (at > 0)
          console.log('')

        console.log(role('path', process.stdout)(result.target))
        console.log(table([['TYPE', 'VALUES'], ...result.records.map(r => [r.type, r.error ?? (r.values.length === 0 ? '-' : r.values.join('\n'))])], { header: true }))
      }
    }

    return results.every(r => r.records.some(rec => rec.values.length > 0)) ? 0 : 1
  }

  const client = network(timeoutMs)
  const reports = await Promise.all(hosts.map(async ({ input, host }) => dnsReport(input, host, client)))

  if (values.json === true) {
    printJson(reports.length === 1 ? reports[0] : reports)
  }
  else {
    for (const [at, report] of reports.entries()) {
      if (at > 0)
        console.log('')

      printDns(report)
    }
  }

  return reports.every(known) ? 0 : 1
}

interface CorsReport extends CorsVerdict {
  target: string
  url: string
  status: number
  request: CorsRequest
}

function printCors(report: CorsReport): void {
  const label = role('label', process.stdout)
  const { request } = report
  const asked = `from ${request.origin}, ${request.method}${request.headers.length === 0 ? '' : ` with ${request.headers.join(', ')}`}`

  console.log(`${marked(report.allowed ? 'ok' : 'problem', report.allowed ? 'allowed' : 'refused', process.stdout)} ${role('value', process.stdout)(String(report.status))} ${role('path', process.stdout)(report.url)}  ${label(asked)}`)

  for (const [name, value] of Object.entries(report.headers))
    console.log(`  ${label(name)} ${value}`)

  for (const reason of report.reasons)
    console.log(marked('problem', reason, process.stdout))

  for (const warning of report.warnings)
    console.log(marked('warn', warning, process.stdout))
}

async function corsCmd(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, CORS_USAGE, CORS_OPTIONS, {
    positionals: ['<origin>', '<url>...'],
    exits: CORS_EXITS,
    examples: [['probe cors https://app.example.com https://api.example.com/items --method PUT', 'check whether a browser preflight succeeds']],
  })
  const [rawOrigin, ...inputs] = positionals
  const origin = originOf(rawOrigin)

  if (origin === undefined)
    badUsage(`origin takes an origin such as https://app.example.com, not ${rawOrigin}`)

  const headers = values.header ?? []

  validateHeaders(headers)

  const timeoutMs = values.timeout === undefined ? undefined : duration(values.timeout, 'timeout', 0, 's')
  const wire: Wire = { headers, resolve: resolvesOf(values.resolve ?? []), ...(timeoutMs === undefined ? {} : { timeoutS: timeoutMs / 1000 }) }
  const targets = inputs.map((input) => {
    const target = parseTarget(input)

    if (target === undefined)
      badUsage(`not a URL or domain: ${input}`)

    return { input, target }
  })
  const request: CorsRequest = { origin, method: methodOf(values.method ?? 'POST'), headers: requestedHeaders(values['cors-headers'] ?? 'content-type') }
  const reports = await Promise.all(targets.map(async ({ input, target }): Promise<CorsReport | { target: string, error: string }> => {
    const { hop, errormsg } = await curlPreflight(target.url.href, request, { ...wire, insecure: values.insecure === true })

    if (hop === undefined)
      return { target: input, error: `could not reach ${target.url.host}: ${errormsg ?? 'no response'}` }

    return { target: input, url: hop.url, status: hop.status, request, ...corsVerdict(hop.status, hop.headers, request) }
  }))
  const [only] = reports

  if (reports.length === 1 && only !== undefined && 'error' in only)
    fail(only.error, 1)

  if (values.json === true) {
    printJson(reports.length === 1 ? only : reports)
  }
  else {
    for (const report of reports) {
      if ('error' in report)
        console.error(marked('problem', report.error, process.stderr))
      else
        printCors(report)
    }
  }

  return reports.every(report => 'allowed' in report && report.allowed) ? 0 : 1
}

async function tlsCmd(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, TLS_USAGE, TLS_OPTIONS, {
    positionals: ['<host[:port]|url>...'],
    exits: TLS_EXITS,
    examples: ['probe tls example.com', 'probe tls localhost:8443 --json'],
  })
  const timeoutMs = values.timeout === undefined ? undefined : duration(values.timeout, 'timeout', 0, 's')
  const resolveMap = resolvesOf(values.resolve ?? [])
  const targets = positionals.map((input) => {
    const target = parseTarget(input)

    if (target === undefined)
      badUsage(`not a URL or host: ${input}`)

    return { input, host: target.url.hostname, port: portOf(target.url) }
  })

  const results = await Promise.all(targets.map(async ({ input, host, port }) => {
    const info = await tlsInfo(host, port, { address: resolveMap.get(host.toLowerCase()), ...(timeoutMs === undefined ? {} : { timeoutS: timeoutMs / 1000 }) })

    if (info === undefined)
      return { target: input, error: `TLS handshake failed for ${host}:${port}` }

    const warnings = warningsOf({ cert: info.cert, authorizationError: info.authorizationError, tooManyRedirects: false })

    return { target: input, host, port, protocol: info.protocol, cipher: info.cipher, alpn: info.alpn ?? null, certificate: info.cert ?? null, authorizationError: info.authorizationError ?? null, warnings }
  }))

  const [only] = results

  if (results.length === 1 && only !== undefined && 'error' in only)
    fail(only.error, 1)

  if (values.json === true) {
    printJson(results.length === 1 ? only : results)

    return results.some(r => 'error' in r) ? 1 : 0
  }

  const label = role('label', process.stdout)
  const row = (name: string, text: string): void => console.log(`${label(name.padEnd(LABEL_WIDTH))} ${text}`)

  for (const [at, result] of results.entries()) {
    if (at > 0)
      console.log('')

    if ('error' in result) {
      console.error(marked('problem', result.error, process.stderr))

      continue
    }

    console.log(`${role('accent', process.stdout)(result.protocol)} ${role('path', process.stdout)(`${result.host}:${result.port}`)}`)
    row('cipher', result.cipher)

    if (result.alpn !== null)
      row('alpn', result.alpn)

    if (result.certificate !== null) {
      row('subject', result.certificate.subject)
      row('issuer', result.certificate.issuer)
      row('expires', `${result.certificate.validTo.slice(0, 10)} (${daysLeftLabel(result.certificate.daysLeft)})`)
      row('names', result.certificate.names.join(', '))
    }

    for (const warning of result.warnings)
      console.log(marked('warn', warning, process.stdout))
  }

  return results.some(r => 'error' in r) ? 1 : 0
}

async function ipCmd(args: string[]): Promise<number> {
  const { values } = parse(args, IP_USAGE, IP_OPTIONS, {
    positionals: [],
    exits: IP_EXITS,
    examples: ['probe ip', 'probe ip -4 --json'],
  })

  if (values[4] === true && values[6] === true)
    badUsage('pass -4 or -6, not both')

  let family: 4 | 6 | undefined

  if (values[4] === true)
    family = 4
  else if (values[6] === true)
    family = 6

  try {
    const ip = await publicIp(family)

    if (values.json === true)
      printJson({ ip })
    else
      console.log(ip)

    return 0
  }
  catch (error) {
    fail(error instanceof Error ? error.message : String(error), 1)
  }
}

process.exitCode = await runCli({
  name: 'probe',
  about: 'HTTP, DNS, CORS, TLS and public IP diagnostics',
  replaces: 'curl -sI chains, openssl s_client, dig @server one-liners and ip lookups',
  defaultCommand: 'http',
  examples: ['probe example.com', ['probe a.test b.test', 'one line each'], 'probe dns -t MX,TXT example.com', 'probe cors https://app.test https://api.test/items', 'probe tls example.com', 'probe ip'],
  commands: {
    http: { summary: 'HTTP version, redirect chain, timings, TLS, headers and security audit (default)', run: httpCmd },
    dns: { summary: 'compare DNS resolvers or query specific record types (-t MX,TXT,CAA,NS,SOA)', run: dnsCmd },
    cors: { summary: 'send a browser CORS preflight and explain whether it succeeds', run: corsCmd },
    tls: { summary: 'direct TLS handshake and certificate inspection without HTTP', run: tlsCmd },
    ip: { summary: 'public IPv4/IPv6 address of this machine', run: ipCmd },
  },
})
