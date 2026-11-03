// Pure functions over what curl, tls and dns return, so the logic is tested with fixtures and no network.

export type Headers = Record<string, string>

export interface Timings {
  dns: number
  connect: number
  tls: number
  firstByte: number
  total: number
}

export interface Hop {
  url: string
  status: number
  version: string
  location?: string
  remoteIp?: string
  timings: Timings
  headers: Headers
}

export interface CertInfo {
  subject: string
  issuer: string
  names: string[]
  validFrom: string
  validTo: string
  daysLeft: number
}

export interface Target {
  url: URL
  // A bare domain: no scheme was given, https is tried first.
  bare: boolean
}

export const SOON_DAYS = 14
export const MAX_HOPS = 10

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const SEPARATOR = '\n---HEADERS---\n'
const CERT_PREFIX = /^(?:DNS|IP Address|IP|email|URI):/
const CACHE_NODE = /cache-/i
const ALT_VALUE = /=.*$/

export function parseTarget(input: string): Target | undefined {
  const bare = !SCHEME.test(input)

  try {
    const url = new URL(bare ? `https://${input}` : input)

    return (url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' ? undefined : { url, bare }
  }
  catch {
    return undefined
  }
}

// The `--write-out` template a hop is run with: curl's JSON, then the response headers as JSON.
export const WRITE_OUT = `%{json}${SEPARATOR}%{header_json}`

export interface CurlResult {
  exitcode: number
  errormsg: string | null
  hop?: Hop
}

function seconds(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function ms(value: number): number {
  return Math.round(value * 1000)
}

// curl's times are cumulative from the start, so each phase is the gap to the one before.
export function timingsOf(info: Record<string, unknown>): Timings {
  const lookup = seconds(info.time_namelookup)
  const connect = seconds(info.time_connect)
  const secure = seconds(info.time_appconnect)
  const ready = secure > 0 ? secure : connect
  const first = seconds(info.time_starttransfer)

  return {
    dns: ms(lookup),
    connect: ms(Math.max(0, connect - lookup)),
    tls: secure > 0 ? ms(Math.max(0, secure - connect)) : 0,
    firstByte: ms(Math.max(0, first - ready)),
    total: ms(seconds(info.time_total)),
  }
}

export function headersOf(json: string): Headers {
  const headers: Headers = {}

  try {
    const parsed: unknown = JSON.parse(json)

    if (typeof parsed !== 'object' || parsed === null)
      return headers

    for (const [name, value] of Object.entries(parsed)) {
      const values = Array.isArray(value) ? value.map(String) : [String(value)]

      headers[name.toLowerCase()] = values.join(', ')
    }
  }
  catch {}

  return headers
}

export function parseCurl(stdout: string): CurlResult {
  const at = stdout.indexOf(SEPARATOR)
  const infoText = at === -1 ? stdout : stdout.slice(0, at)
  let info: Record<string, unknown>

  try {
    info = JSON.parse(infoText) as Record<string, unknown>
  }
  catch {
    return { exitcode: 1, errormsg: 'curl printed no result' }
  }

  const exitcode = typeof info.exitcode === 'number' ? info.exitcode : 1
  const errormsg = typeof info.errormsg === 'string' ? info.errormsg : null
  const status = typeof info.response_code === 'number' ? info.response_code : 0

  if (exitcode !== 0 || status === 0)
    return { exitcode: exitcode === 0 ? 1 : exitcode, errormsg: errormsg ?? 'no response' }

  const headers = headersOf(at === -1 ? '' : stdout.slice(at + SEPARATOR.length))
  const hop: Hop = {
    url: String(info.url_effective ?? info.url ?? ''),
    status,
    version: String(info.http_version ?? ''),
    timings: timingsOf(info),
    headers,
  }

  if (typeof info.redirect_url === 'string' && info.redirect_url !== '')
    hop.location = info.redirect_url
  else if (headers.location !== undefined)
    hop.location = headers.location

  if (typeof info.remote_ip === 'string' && info.remote_ip !== '')
    hop.remoteIp = info.remote_ip

  return { exitcode, errormsg, hop }
}

export function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

// The next URL of a redirect, resolved against the current one.
export function nextUrl(current: string, location: string): string | undefined {
  try {
    const next = new URL(location, current)

    return next.protocol === 'http:' || next.protocol === 'https:' ? next.href : undefined
  }
  catch {
    return undefined
  }
}

// `HTTP/1.1`, `HTTP/2`, `HTTP/3` from curl's `1.1`, `2`, `3`.
export function versionLabel(version: string): string {
  return version === '' ? 'unknown' : `HTTP/${version}`
}

// The protocol ids an `alt-svc` header offers: `h3=":443"; ma=86400, h2=":443"` gives `['h3', 'h2']`.
export function altSvcProtocols(altSvc: string | undefined): string[] {
  if (altSvc === undefined || altSvc.trim() === 'clear')
    return []

  const ids = altSvc.split(',').map(entry => entry.trim().replace(ALT_VALUE, '')).filter(id => id !== '')

  return [...new Set(ids)]
}

export interface Offers {
  h2: boolean
  h3: boolean
  altSvc: string[]
}

// h2 is offered when the TLS handshake picked it or the response came over it, h3 when curl spoke it or alt-svc advertises it.
export function offersOf(options: { alpn?: string | undefined, version: string, altSvc: string | undefined }): Offers {
  const altSvc = altSvcProtocols(options.altSvc)

  return {
    h2: options.alpn === 'h2' || options.version === '2' || options.version === '3',
    h3: options.version === '3' || altSvc.some(id => id === 'h3' || id.startsWith('h3-')),
    altSvc,
  }
}

const KNOWN_SERVERS: [RegExp, string][] = [
  [/cloudflare/i, 'Cloudflare'],
  [/cloudfront/i, 'CloudFront'],
  [/akamai/i, 'Akamai'],
  [/fastly/i, 'Fastly'],
  [/vercel/i, 'Vercel'],
  [/netlify/i, 'Netlify'],
  [/bunnycdn/i, 'BunnyCDN'],
  [/gws|esf|google frontend|gse/i, 'Google'],
]

// A CDN or proxy guess from the headers that give one away, with the header that did.
export function cdnHint(headers: Headers): string | undefined {
  const served = headers['x-served-by']

  if (headers['cf-ray'] !== undefined)
    return 'Cloudflare (cf-ray)'

  if (served !== undefined)
    return `${CACHE_NODE.test(served) ? 'Fastly' : served} (x-served-by)`

  if (headers['x-amz-cf-id'] !== undefined)
    return 'CloudFront (x-amz-cf-id)'

  if (headers['x-vercel-id'] !== undefined)
    return 'Vercel (x-vercel-id)'

  if (headers.via !== undefined)
    return `${headers.via} (via)`

  if (headers['x-cache'] !== undefined)
    return `${headers['x-cache']} (x-cache)`

  const server = headers.server

  if (server !== undefined) {
    const known = KNOWN_SERVERS.find(([pattern]) => pattern.test(server))

    if (known !== undefined)
      return `${known[1]} (server)`
  }

  return undefined
}

export const WORTH_KNOWING = ['server', 'content-type', 'content-encoding', 'cache-control', 'strict-transport-security'] as const

export function worthKnowing(headers: Headers): Headers {
  const kept: Headers = {}

  for (const name of WORTH_KNOWING) {
    const value = headers[name]

    if (value !== undefined)
      kept[name] = value
  }

  return kept
}

function field(value: unknown): string {
  if (typeof value === 'string')
    return value

  return Array.isArray(value) ? value.join(', ') : ''
}

// `{ CN: 'x', O: 'y' }` as `x (y)`.
export function nameOf(entry: Record<string, unknown> | undefined): string {
  if (entry === undefined)
    return ''

  const common = field(entry.CN)
  const organization = field(entry.O)

  if (common !== '' && organization !== '' && common !== organization)
    return `${common} (${organization})`

  return common === '' ? organization : common
}

// `DNS:a.test, DNS:*.a.test, IP Address:1.2.3.4` as the bare names.
export function namesOf(subjectaltname: string | undefined): string[] {
  if (subjectaltname === undefined)
    return []

  return subjectaltname.split(',').map(entry => entry.trim().replace(CERT_PREFIX, '')).filter(name => name !== '')
}

export interface RawCertificate {
  subject?: Record<string, unknown>
  issuer?: Record<string, unknown>
  subjectaltname?: string
  valid_from?: string
  valid_to?: string
}

export function certInfo(raw: RawCertificate, now = Date.now()): CertInfo | undefined {
  if (raw.valid_to === undefined || raw.valid_from === undefined)
    return undefined

  const end = Date.parse(raw.valid_to)
  const start = Date.parse(raw.valid_from)

  if (Number.isNaN(end) || Number.isNaN(start))
    return undefined

  return {
    subject: nameOf(raw.subject),
    issuer: nameOf(raw.issuer),
    names: namesOf(raw.subjectaltname),
    validFrom: new Date(start).toISOString(),
    validTo: new Date(end).toISOString(),
    daysLeft: Math.floor((end - now) / 86_400_000),
  }
}

export interface HttpRedirect {
  status: number
  location?: string
  toHttps: boolean
}

// What the http:// twin of an https site answered, undefined when it did not answer at all.
export function httpRedirectOf(hop: Hop | undefined): HttpRedirect | undefined {
  if (hop === undefined)
    return undefined

  const next = hop.location === undefined ? undefined : nextUrl(hop.url, hop.location)
  const redirect: HttpRedirect = { status: hop.status, toHttps: isRedirect(hop.status) && next !== undefined && new URL(next).protocol === 'https:' }

  if (hop.location !== undefined)
    redirect.location = hop.location

  return redirect
}

// Whether the http:// twin is worth probing: the target is a bare domain or an https URL on the default port.
export function wantsHttpCheck(target: Target): boolean {
  return target.url.protocol === 'https:' && target.url.port === ''
}

export interface WarningInput {
  cert?: CertInfo | undefined
  authorizationError?: string | undefined
  httpRedirect?: HttpRedirect | undefined
  tooManyRedirects: boolean
}

export function warningsOf(input: WarningInput): string[] {
  const warnings: string[] = []
  const { cert, httpRedirect } = input

  if (cert !== undefined) {
    if (cert.daysLeft < 0)
      warnings.push(`certificate expired ${-cert.daysLeft} days ago`)
    else if (cert.daysLeft < SOON_DAYS)
      warnings.push(`certificate expires in ${cert.daysLeft} days`)
  }

  if (input.authorizationError !== undefined)
    warnings.push(`certificate not trusted: ${input.authorizationError}`)

  if (httpRedirect !== undefined && !httpRedirect.toHttps)
    warnings.push(`http:// answers ${httpRedirect.status} and does not redirect to https`)

  if (input.tooManyRedirects)
    warnings.push(`more than ${MAX_HOPS} redirects`)

  return warnings
}
