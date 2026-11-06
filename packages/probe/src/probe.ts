#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { CertInfo, Headers, Hop, HttpRedirect, Offers, Target, Timings } from './analyze'
import type { CorsRequest, CorsVerdict } from './cors'
import type { DnsReport } from './dns'
import type { Addresses, TlsInfo, Wire } from './net'
import { isIP } from 'node:net'
import process from 'node:process'
import { badUsage, duration, fail, jsonOption, marked, paint, parse, printJson, role, runMain, table } from '@kaynooo/cli-kit'
import { cdnHint, daysLeftLabel, httpRedirectOf, isRedirect, MAX_HOPS, nextUrl, offersOf, parseTarget, versionLabel, wantsHttpCheck, warningsOf, worthKnowing } from './analyze'
import { corsVerdict, methodOf, originOf, requestedHeaders } from './cors'
import { dnsReport, known, network } from './dns'
import { addressesOf, curlHasHttp3, curlHop, curlPreflight, portOf, tlsInfo } from './net'

const LABEL_WIDTH = 13

const USAGE = `probe [options] <url|domain>...: reports each site's negotiated HTTP version, redirect chain, timings, addresses, TLS and certificate, the headers worth knowing and what warrants a warning

By default one line per target: the HTTP version, status, final URL, total time, redirects, certificate expiry, first address and the warnings. --verbose prints the whole table.
A bare domain is tried over https first and over http when that fails. Redirects are followed hop by hop (at most ${MAX_HOPS}), each hop's status and HTTP version listed. HTTP/3 is spoken only when the installed curl lists it, otherwise it is reported from alt-svc. The certificate is read even when it is not trusted, and --insecure also lets curl go on with it.
-H adds a header to every request, --resolve host:ip reaches a host at that address instead of the DNS answer (the certificate and the Host header stay the host's), both repeatable.

Warns on a certificate with fewer than 14 days left or not trusted, and on an http:// twin that does not redirect to https (checked for a bare domain or an https URL on the default port).

--dns makes no HTTP request: it asks the system resolver, Cloudflare, Google, Quad9 and each nameserver of the host's zone for its A, AAAA and CNAME records with their TTL, and warns on a resolver answering otherwise than the zone's nameservers, a change not reached it yet.
--cors <origin> sends the preflight a browser on that origin would send before a --method request carrying --cors-headers, and says whether the browser would go on, with each reason when it would not.`

const EXITS: ExitRow[] = [[0, 'every site answered, warnings or not'], [1, 'a site could not be reached, a CORS preflight was refused, or no resolver knows a name'], [2, 'a usage error']]

const OPTIONS = {
  'insecure': { type: 'boolean', short: 'k', description: 'let curl go on with a certificate it does not trust' },
  'header': { type: 'string', short: 'H', multiple: true, description: 'a `Name: value` header sent with every request, repeatable' },
  'resolve': { type: 'string', multiple: true, description: 'host:ip, reach the host at that address instead of the DNS answer, repeatable' },
  'timeout': { type: 'string', short: 't', description: 'longest one request may take (20s, 3s for a DNS query): 5s, 1m, a bare number in seconds' },
  'verbose': { type: 'boolean', description: 'the whole table for each target instead of one line' },
  'dns': { type: 'boolean', description: 'compare what each resolver and the zone\'s nameservers answer for the host, no HTTP request', conflicts: ['cors', 'header', 'resolve', 'insecure', 'verbose'] },
  'cors': { type: 'string', description: 'the origin a browser would call from: whether its CORS preflight lets the request through', conflicts: ['dns', 'verbose'] },
  'method': { type: 'string', description: 'with --cors, the method of the request the preflight asks for (POST)' },
  'cors-headers': { type: 'string', description: 'with --cors, the headers it carries, comma separated, empty for none (content-type)' },
  'json': jsonOption('one object per target {target, url, version, status, chain, timings, addresses, tls, certificate, headers, cdn, offers, httpRedirect, warnings}, an array of them for several targets (an unreachable one is {target, error}); with --dns {target, zone, answers, agree, warnings}, with --cors {target, url, status, request, allowed, reasons, warnings, headers}'),
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
  cdn: string | null
  offers: Offers
  httpRedirect: HttpRedirect | null
  warnings: string[]
}

interface Followed {
  chain: Hop[]
  error?: string
  tooMany: boolean
}

interface Settings {
  insecure: boolean
  wire: Wire
}

async function follow(start: string, { insecure, wire }: Settings, http3: boolean): Promise<Followed> {
  const chain: Hop[] = []
  let url = start

  while (chain.length < MAX_HOPS) {
    const { hop, errormsg } = await curlHop(url, { ...wire, http3: http3 && url.startsWith('https:'), insecure, get: false })

    if (hop === undefined)
      return { chain, error: errormsg ?? 'no response', tooMany: false }

    chain.push(hop)

    const next = hop.location === undefined ? undefined : nextUrl(hop.url, hop.location)

    if (!isRedirect(hop.status) || next === undefined)
      return { chain, tooMany: false }

    url = next
  }

  return { chain, tooMany: true }
}

async function probe(target: Target, input: string, settings: Settings): Promise<Report | { target: string, error: string }> {
  const { wire } = settings
  const http3 = await curlHasHttp3()
  let followed = await follow(target.url.href, settings, http3)

  if (followed.chain.length === 0 && target.bare) {
    const plain = new URL(target.url.href)

    plain.protocol = 'http:'

    const second = await follow(plain.href, settings, http3)

    if (second.chain.length > 0)
      followed = second
  }

  const final = followed.chain.at(-1)

  if (final === undefined)
    return { target: input, error: `could not reach ${target.url.host}: ${followed.error ?? 'no response'}` }

  const finalUrl = new URL(final.url)
  const secure = finalUrl.protocol === 'https:'
  const [addresses, tls, twin] = await Promise.all([
    addressesOf(target.url.hostname, wire.resolve),
    secure ? tlsInfo(finalUrl.hostname, portOf(finalUrl), { address: wire.resolve?.get(finalUrl.hostname), ...wire.timeoutS === undefined ? {} : { timeoutS: wire.timeoutS } }) : Promise.resolve(undefined as TlsInfo | undefined),
    wantsHttpCheck(target) && secure ? twinOf(target.url, settings) : Promise.resolve(undefined),
  ])
  const httpRedirect = httpRedirectOf(twin)
  const offers = offersOf({ alpn: tls?.alpn, version: final.version, altSvc: final.headers['alt-svc'] })
  const warnings = warningsOf({ cert: tls?.cert, authorizationError: tls?.authorizationError, httpRedirect, tooManyRedirects: followed.tooMany })

  if (!secure)
    warnings.push('the site is not served over https')

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
    headers: worthKnowing(final.headers),
    cdn: cdnHint(final.headers) ?? null,
    offers,
    httpRedirect: httpRedirect ?? null,
    warnings,
  }
}

async function twinOf(url: URL, { insecure, wire }: Settings): Promise<Hop | undefined> {
  const plain = new URL(url.href)

  plain.protocol = 'http:'

  return (await curlHop(plain.href, { ...wire, http3: false, insecure, get: false })).hop
}

// `host:ip` pairs as a map from the lowercase host; the first colon splits them, an IPv6 address keeping its own.
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

function ms(value: number): string {
  return `${value}ms`
}

// The report on one line.
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

  if (report.cdn !== null)
    row('cdn', report.cdn)

  if (report.httpRedirect !== null)
    row('http://', report.httpRedirect.toHttps ? `redirects to https (${report.httpRedirect.status})` : `answers ${report.httpRedirect.status}`)

  for (const warning of report.warnings)
    console.log(marked('warn', warning, process.stdout))
}

function printDns(report: DnsReport): void {
  const label = role('label', process.stdout)
  const listed = (values: string[]): string => values.length === 0 ? '-' : values.join(' ')

  console.log(`${role('path', process.stdout)(report.target)}  ${label(report.zone === null ? 'no zone found' : `zone ${report.zone}`)}`)
  console.log(table([
    ['RESOLVER', 'SERVER', 'A', 'AAAA', 'CNAME', 'TTL'],
    ...report.answers.map(answer => [
      answer.authoritative ? `${answer.resolver} (ns)` : answer.resolver,
      answer.server,
      ...answer.error === undefined ? [listed(answer.a), listed(answer.aaaa), listed(answer.cname)] : [answer.error, '', ''],
      answer.ttl === null ? '-' : `${answer.ttl}s`,
    ]),
  ], { header: true }))

  if (report.agree)
    console.log(marked('ok', 'every resolver gives the same answer', process.stdout))

  for (const warning of report.warnings)
    console.log(marked('warn', warning, process.stdout))
}

async function dnsMain(inputs: string[], timeoutMs: number | undefined, json: boolean): Promise<number> {
  const hosts = inputs.map((input) => {
    const host = parseTarget(input)?.url.hostname

    if (host === undefined)
      badUsage(`not a URL or domain: ${input}`)

    if (isIP(host.replace(BRACKETS, '')) !== 0)
      badUsage(`--dns takes a name, not the address ${input}`)

    return { input, host }
  })
  const client = network(timeoutMs)
  const reports = await Promise.all(hosts.map(async ({ input, host }) => dnsReport(input, host, client)))

  if (json) {
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

async function corsMain(targets: { input: string, target: Target }[], request: CorsRequest, { insecure, wire }: Settings, json: boolean): Promise<number> {
  const reports = await Promise.all(targets.map(async ({ input, target }): Promise<CorsReport | { target: string, error: string }> => {
    const { hop, errormsg } = await curlPreflight(target.url.href, request, { ...wire, insecure })

    if (hop === undefined)
      return { target: input, error: `could not reach ${target.url.host}: ${errormsg ?? 'no response'}` }

    return { target: input, url: hop.url, status: hop.status, request, ...corsVerdict(hop.status, hop.headers, request) }
  }))
  const [only] = reports

  if (reports.length === 1 && only !== undefined && 'error' in only)
    fail(only.error, 1)

  if (json) {
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

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['<url|domain>...'], exits: EXITS, replaces: 'the httpversion fish function, curl -sI chains, openssl s_client and dig @server one-liners', examples: ['probe example.com', 'probe https://example.com/path --json', ['probe a.test b.test', 'one line each'], ['probe https://example.com --resolve example.com:203.0.113.7 -H "Host: example.com" --verbose', 'a server before its DNS points at it'], ['probe --dns example.com', 'whether a DNS change has reached every resolver'], ['probe --cors https://app.example.com --method PUT --cors-headers content-type,authorization https://api.example.com/items', 'whether the browser would let the call through']] })

  if (values.cors === undefined) {
    if (values.method !== undefined)
      badUsage('--method goes with --cors')

    if (values['cors-headers'] !== undefined)
      badUsage('--cors-headers goes with --cors')
  }

  const headers = values.header ?? []

  for (const header of headers) {
    if (!HEADER_LINE.test(header))
      badUsage(`-H takes "Name: value", not ${header}`)
  }

  const timeoutMs = values.timeout === undefined ? undefined : duration(values.timeout, 'timeout', 0, 's')

  if (values.dns === true)
    return dnsMain(positionals, timeoutMs, values.json === true)

  const wire: Wire = { headers, resolve: resolvesOf(values.resolve ?? []), ...timeoutMs === undefined ? {} : { timeoutS: timeoutMs / 1000 } }
  const targets = positionals.map((input) => {
    const target = parseTarget(input)

    if (target === undefined)
      badUsage(`not a URL or domain: ${input}`)

    return { input, target }
  })

  if (values.cors !== undefined) {
    const origin = originOf(values.cors)

    if (origin === undefined)
      badUsage(`--cors takes an origin such as https://app.example.com, not ${values.cors}`)

    const request = { origin, method: methodOf(values.method ?? 'POST'), headers: requestedHeaders(values['cors-headers'] ?? 'content-type') }

    return corsMain(targets, request, { insecure: values.insecure === true, wire }, values.json === true)
  }

  const reports = await Promise.all(targets.map(async ({ input, target }) => probe(target, input, { insecure: values.insecure === true, wire })))
  const [only] = reports

  if (reports.length === 1 && only !== undefined && 'error' in only)
    fail(only.error, 1)

  if (values.json === true) {
    printJson(reports.length === 1 ? only : reports)

    return reports.some(report => 'error' in report) ? 1 : 0
  }

  let first = true

  for (const report of reports) {
    if ('error' in report) {
      console.error(marked('problem', report.error, process.stderr))
    }
    else if (values.verbose === true) {
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

  return reports.some(report => 'error' in report) ? 1 : 0
}

process.exitCode = await runMain({ name: 'probe', run: main })
