import type { Headers } from './analyze'

/** What the browser asks before a cross-origin request: from which origin, with which method and which headers. */
export interface CorsRequest {
  origin: string
  method: string
  headers: string[]
}

export interface CorsVerdict {
  allowed: boolean
  // Why a browser would refuse the request, empty when it goes through.
  reasons: string[]
  warnings: string[]
  // The `access-control-*` headers and `vary` the preflight answered with.
  headers: Headers
}

// The methods a preflight never needs to list, CORS letting them through as long as the origin is allowed.
const SIMPLE_METHODS = new Set(['GET', 'HEAD', 'POST'])
// The methods fetch uppercases as the page gives them; any other is sent, and has to be listed, as typed.
const NORMALIZED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'])
// Headers a browser leaves out of the preflight, CORS letting them through unlisted. content-type is not among them: it is named for a type other than a form's.
const SAFELISTED_HEADERS = new Set(['accept', 'accept-language', 'content-language'])
const LIST = /\s*,\s*/
const HOSTED_SCHEME = /^[a-z][a-z0-9+.-]*:\/\/[^/]/i

function listOf(value: string | undefined): string[] {
  return value === undefined ? [] : value.trim().split(LIST).filter(item => item !== '')
}

/** The method as fetch sends it. */
export function methodOf(input: string): string {
  return NORMALIZED_METHODS.has(input.toUpperCase()) ? input.toUpperCase() : input
}

/** The headers a browser names in the preflight's Access-Control-Request-Headers, out of the comma separated ones a request carries: lowercase, safelisted ones left out. */
export function requestedHeaders(value: string): string[] {
  return listOf(value).map(name => name.toLowerCase()).filter(name => !SAFELISTED_HEADERS.has(name))
}

/** The origin as a browser sends it, scheme, host and port with no path, `null` for an opaque one; undefined for what no page has as its origin. */
export function originOf(input: string): string | undefined {
  if (input === 'null')
    return input

  if (!HOSTED_SCHEME.test(input) || !URL.canParse(input))
    return undefined

  const url = new URL(input)

  return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin
}

/** Whether a browser would send the request after this preflight answer, by the Fetch standard's CORS checks, with each reason when it would not. */
export function corsVerdict(status: number, headers: Headers, request: CorsRequest): CorsVerdict {
  const reasons: string[] = []
  const warnings: string[] = []
  const origin = headers['access-control-allow-origin']
  const credentials = headers['access-control-allow-credentials'] === 'true'
  const methods = listOf(headers['access-control-allow-methods'])
  const allowedHeaders = new Set(listOf(headers['access-control-allow-headers']).map(name => name.toLowerCase()))

  if (status < 200 || status > 299)
    reasons.push(`the preflight answered ${status}, a browser wants a 2xx`)

  if (origin === undefined)
    reasons.push('no access-control-allow-origin')
  else if (origin !== '*' && origin !== request.origin)
    reasons.push(`access-control-allow-origin is ${origin}, not ${request.origin}`)

  // Listed methods match byte for byte, as browsers compare them.
  const { method } = request

  if (!SIMPLE_METHODS.has(method) && !methods.includes('*') && !methods.includes(method))
    reasons.push(methods.length === 0 ? `no access-control-allow-methods, which ${method} needs` : `access-control-allow-methods (${methods.join(', ')}) does not list ${method}`)

  // A wildcard covers every header but authorization, which has to be named.
  const missing = request.headers.map(name => name.toLowerCase()).filter(name => !allowedHeaders.has(name) && (name === 'authorization' || !allowedHeaders.has('*')))

  if (missing.length > 0)
    reasons.push(`access-control-allow-headers does not cover ${missing.join(', ')}`)

  if (credentials && (origin === '*' || methods.includes('*') || allowedHeaders.has('*')))
    warnings.push('access-control-allow-credentials comes with a * wildcard, which a request with cookies or auth does not get')

  if (origin === request.origin && !listOf(headers.vary).some(name => name.toLowerCase() === 'origin' || name === '*'))
    warnings.push('if the origin is echoed back from the request, vary lacks origin: a cache may hand this answer to another origin')

  const shown = Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('access-control-') || name === 'vary'))

  return { allowed: reasons.length === 0, reasons, warnings, headers: shown }
}
