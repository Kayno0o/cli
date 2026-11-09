import type { CertInfo, CurlResult } from './analyze'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { connect } from 'node:tls'
import { certInfo, parseCurl, WRITE_OUT } from './analyze'

const CONNECT_TIMEOUT = 10
const MAX_TIME = 20
const HTTP3_FEATURE = /^Features:.*\bHTTP3\b/m
const BRACKETS = /^\[|\]$/g

let http3: boolean | undefined

// Whether the installed curl lists HTTP3 among its features.
export async function curlHasHttp3(): Promise<boolean> {
  if (http3 !== undefined)
    return http3

  try {
    const result = Bun.spawn(['curl', '--version'], { stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(result.stdout).text()

    http3 = HTTP3_FEATURE.test(text)
  }
  catch {
    http3 = false
  }

  return http3
}

export interface Wire {
  // `Name: value` lines sent with every request.
  headers?: string[]
  // Host (lowercase) to the address that answers for it, instead of DNS.
  resolve?: ReadonlyMap<string, string>
  // The longest one request may take, in seconds.
  timeoutS?: number
}

export interface HopOptions extends Wire {
  http3: boolean
  insecure: boolean
  get: boolean
  // Sent as this method, a body-less request read whole: OPTIONS for a CORS preflight.
  method?: string
}

// The port a URL is reached on, which curl's --resolve needs spelled out.
export function portOf(url: URL): number {
  if (url.port !== '')
    return Number(url.port)

  return url.protocol === 'https:' ? 443 : 80
}

function curlResolve(url: string, resolve: ReadonlyMap<string, string> | undefined): string[] {
  const parsed = URL.canParse(url) ? new URL(url) : undefined
  const address = parsed === undefined ? undefined : resolve?.get(parsed.hostname)

  if (parsed === undefined || address === undefined)
    return []

  return ['--resolve', `${parsed.hostname}:${portOf(parsed)}:${isIP(address) === 6 ? `[${address}]` : address}`]
}

async function runCurl(url: string, { http3: wantsH3, insecure, get, method, headers = [], resolve, timeoutS = MAX_TIME }: HopOptions): Promise<CurlResult> {
  const args = ['-sS', '-o', '/dev/null', '--connect-timeout', String(Math.min(CONNECT_TIMEOUT, timeoutS)), '--max-time', String(timeoutS), '--write-out', WRITE_OUT, ...curlResolve(url, resolve)]

  for (const header of headers)
    args.push('-H', header)

  if (method !== undefined)
    args.push('-X', method)
  else if (!get)
    args.push('-I')

  if (wantsH3)
    args.push('--http3')

  if (insecure)
    args.push('--insecure')

  try {
    const result = Bun.spawn(['curl', ...args, url], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited])

    return parseCurl(stdout)
  }
  catch {
    return { exitcode: 127, errormsg: 'curl is not installed' }
  }
}

// One request, redirects not followed. A server answering HEAD with an error status is asked again with GET, as many answer HEAD wrongly, and an HTTP/3 attempt that fails is retried without it.
export async function curlHop(url: string, options: HopOptions): Promise<CurlResult> {
  let result = await runCurl(url, options)

  if (result.hop === undefined && options.http3)
    result = await runCurl(url, { ...options, http3: false })

  if (result.hop !== undefined && !options.get && result.hop.status >= 400)
    result = await runCurl(url, { ...options, get: true })

  return result
}

/** The preflight a browser sends before a cross-origin request: the answer as is, no retry with another method. */
export async function curlPreflight(url: string, request: { origin: string, method: string, headers: string[] }, options: Wire & { insecure: boolean }): Promise<CurlResult> {
  const asked = [`Origin: ${request.origin}`, `Access-Control-Request-Method: ${request.method}`, ...request.headers.length > 0 ? [`Access-Control-Request-Headers: ${request.headers.join(', ')}`] : []]

  return runCurl(url, { ...options, headers: [...options.headers ?? [], ...asked], http3: false, get: true, method: 'OPTIONS' })
}

export interface Addresses {
  a: string[]
  aaaa: string[]
}

export async function addressesOf(host: string, resolve?: ReadonlyMap<string, string>): Promise<Addresses> {
  const bare = resolve?.get(host) ?? host.replace(BRACKETS, '')
  const family = isIP(bare)

  if (family !== 0)
    return family === 4 ? { a: [bare], aaaa: [] } : { a: [], aaaa: [bare] }

  try {
    const found = await lookup(bare, { all: true })

    return { a: found.filter(entry => entry.family === 4).map(entry => entry.address), aaaa: found.filter(entry => entry.family === 6).map(entry => entry.address) }
  }
  catch {
    return { a: [], aaaa: [] }
  }
}

export interface TlsInfo {
  protocol: string
  cipher: string
  alpn: string | undefined
  authorizationError: string | undefined
  cert: CertInfo | undefined
}

// A handshake offering h2 and http/1.1 to read the certificate and what was negotiated; an untrusted certificate is reported, not rejected. `address` connects there instead of to the host, which still names the certificate asked for.
export async function tlsInfo(host: string, port: number, { address, timeoutS = CONNECT_TIMEOUT }: { address?: string | undefined, timeoutS?: number } = {}): Promise<TlsInfo | undefined> {
  const bare = host.replace(BRACKETS, '')

  return new Promise((resolve) => {
    const socket = connect({ host: address ?? bare, port, servername: isIP(bare) === 0 ? bare : '', ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized: false, timeout: Math.min(CONNECT_TIMEOUT, timeoutS) * 1000 })

    socket.on('secureConnect', () => {
      const error: unknown = socket.authorizationError

      resolve({
        protocol: socket.getProtocol() ?? '',
        cipher: socket.getCipher().name,
        alpn: typeof socket.alpnProtocol === 'string' ? socket.alpnProtocol : undefined,
        authorizationError: error === null || error === undefined || error === false ? undefined : String(error),
        cert: certInfo(socket.getPeerCertificate()),
      })
      socket.end()
    })
    socket.on('error', () => resolve(undefined))
    socket.on('timeout', () => {
      socket.destroy()
      resolve(undefined)
    })
  })
}
