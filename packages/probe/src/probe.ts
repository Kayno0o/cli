#!/usr/bin/env bun

import type { CertInfo, Headers, Hop, HttpRedirect, Offers, Timings } from './analyze'
import type { Addresses, TlsInfo } from './net'
import process from 'node:process'
import { badUsage, fail, jsonOption, marked, parse, printJson, role, runMain, table } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { cdnHint, daysLeftLabel, httpRedirectOf, isRedirect, MAX_HOPS, nextUrl, offersOf, parseTarget, versionLabel, wantsHttpCheck, warningsOf, worthKnowing } from './analyze'
import { addressesOf, curlHasHttp3, curlHop, tlsInfo } from './net'

const LABEL_WIDTH = 13

const USAGE = `probe [options] <url|domain>: reports a site's negotiated HTTP version, redirect chain, timings, addresses, TLS and certificate, the headers worth knowing and what warrants a warning

A bare domain is tried over https first and over http when that fails. Redirects are followed hop by hop (at most ${MAX_HOPS}), each hop's status and HTTP version listed. HTTP/3 is spoken only when the installed curl lists it, otherwise it is reported from alt-svc. The certificate is read even when it is not trusted, and --insecure also lets curl go on with it.

Warns on a certificate with fewer than 14 days left or not trusted, and on an http:// twin that does not redirect to https (checked for a bare domain or an https URL on the default port).

Exits 0 when the site answered, 1 when it could not be reached, 2 on a usage error.`

const OPTIONS = {
  insecure: { type: 'boolean', short: 'k', description: 'let curl go on with a certificate it does not trust' },
  json: jsonOption('{target, url, version, status, chain, timings, addresses, tls, certificate, headers, cdn, offers, httpRedirect, warnings}'),
} as const

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

async function follow(start: string, insecure: boolean, http3: boolean): Promise<Followed> {
  const chain: Hop[] = []
  let url = start

  while (chain.length < MAX_HOPS) {
    const { hop, errormsg } = await curlHop(url, { http3: http3 && url.startsWith('https:'), insecure, get: false })

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

function portOf(url: URL): number {
  if (url.port !== '')
    return Number(url.port)

  return url.protocol === 'https:' ? 443 : 80
}

async function probe(input: string, insecure: boolean): Promise<Report | { error: string }> {
  const target = parseTarget(input)

  if (target === undefined)
    badUsage(`not a URL or domain: ${input}`)

  const http3 = await curlHasHttp3()
  let followed = await follow(target.url.href, insecure, http3)

  if (followed.chain.length === 0 && target.bare) {
    const plain = new URL(target.url.href)

    plain.protocol = 'http:'

    const second = await follow(plain.href, insecure, http3)

    if (second.chain.length > 0)
      followed = second
  }

  const final = followed.chain.at(-1)

  if (final === undefined)
    return { error: `could not reach ${target.url.host}: ${followed.error ?? 'no response'}` }

  const finalUrl = new URL(final.url)
  const secure = finalUrl.protocol === 'https:'
  const [addresses, tls, twin] = await Promise.all([
    addressesOf(target.url.hostname),
    secure ? tlsInfo(finalUrl.hostname, portOf(finalUrl)) : Promise.resolve(undefined as TlsInfo | undefined),
    wantsHttpCheck(target) && secure ? twinOf(target.url, insecure) : Promise.resolve(undefined),
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

async function twinOf(url: URL, insecure: boolean): Promise<Hop | undefined> {
  const plain = new URL(url.href)

  plain.protocol = 'http:'

  return (await curlHop(plain.href, { http3: false, insecure, get: false })).hop
}

function ms(value: number): string {
  return `${value}ms`
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

async function main(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { positionals: ['<url|domain>'], replaces: 'the httpversion fish function, curl -sI chains and openssl s_client one-liners', examples: ['probe example.com', 'probe https://example.com/path --json'] })
  const report = await probe(positionals[0], values.insecure === true)

  if ('error' in report)
    fail(report.error, 1)

  if (values.json === true)
    printJson(report)
  else
    print(report)

  return 0
}

process.exitCode = await runMain({ name: 'probe', version, run: main })
