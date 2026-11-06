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
const LIST = /\s*,\s*/

function listOf(value: string | undefined): string[] {
  return value === undefined ? [] : value.trim().split(LIST).filter(item => item !== '')
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

  const method = request.method.toUpperCase()

  if (!SIMPLE_METHODS.has(method) && !methods.includes('*') && !methods.some(listed => listed.toUpperCase() === method))
    reasons.push(methods.length === 0 ? `no access-control-allow-methods, which ${method} needs` : `access-control-allow-methods (${methods.join(', ')}) does not list ${method}`)

  // A wildcard covers every header but authorization, which has to be named.
  const missing = request.headers.map(name => name.toLowerCase()).filter(name => !allowedHeaders.has(name) && (name === 'authorization' || !allowedHeaders.has('*')))

  if (missing.length > 0)
    reasons.push(`access-control-allow-headers does not cover ${missing.join(', ')}`)

  if (credentials && (origin === '*' || methods.includes('*') || allowedHeaders.has('*')))
    warnings.push('access-control-allow-credentials comes with a * wildcard, which a request with cookies or auth does not get')

  if (origin !== undefined && origin !== '*' && !listOf(headers.vary).some(name => name.toLowerCase() === 'origin' || name === '*'))
    warnings.push('the allowed origin varies but vary lacks origin: a cache may hand this answer to another origin')

  const shown = Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('access-control-') || name === 'vary'))

  return { allowed: reasons.length === 0, reasons, warnings, headers: shown }
}
