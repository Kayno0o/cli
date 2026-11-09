import { fail } from '@kaynooo/cli-kit'

export const PUBLIC_REGISTRY = 'https://registry.npmjs.org'
const DOWNLOADS_API = 'https://api.npmjs.org/downloads/point/last-week'
const TRAILING_SLASHES = /\/+$/
const REQUEST_TIMEOUT = 10_000
// The npm name grammar: an optional scope, then url-safe characters, no leading dot or underscore.
const PACKAGE_NAME = /^(?:@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*$/

export interface Registry {
  url: string
  token?: string | undefined
}

export interface Version {
  version: string
  scripts?: Record<string, string>
  deprecated?: string
  license?: string | { type?: string }
  _npmUser?: { name?: string }
  dist?: { attestations?: unknown }
}

export interface Packument {
  'name': string
  'description'?: string
  'dist-tags'?: Record<string, string>
  'time'?: Record<string, string>
  'versions'?: Record<string, Version>
  'license'?: string | { type?: string }
  'repository'?: string | { url?: string }
  'homepage'?: string
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export function isPublic(registry: Registry): boolean {
  return registry.url.replace(TRAILING_SLASHES, '') === PUBLIC_REGISTRY
}

// What a lookup that could not be made ends on: exit 2, which is "could not check" and never the 1 of "this package is blocked".
export function unreachable(message: string): never {
  return fail(`could not check: ${message}`, 2)
}

// The request options every registry call carries, a deadline included.
export function requestInit(token?: string): RequestInit {
  return { headers: { accept: 'application/json', ...token === undefined ? {} : { authorization: `Bearer ${token}` } }, signal: AbortSignal.timeout(REQUEST_TIMEOUT) }
}

async function get(fetcher: Fetcher, url: string, token?: string): Promise<Response> {
  try {
    return await fetcher(url, requestInit(token))
  }
  catch (error) {
    return unreachable(`cannot reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function isValidName(name: string): boolean {
  return PACKAGE_NAME.test(name) && name.length <= 214
}

// The full metadata document, which carries the publish times and licence that the abbreviated one leaves out; undefined when the registry has no such package.
export async function fetchPackument(name: string, registry: Registry, fetcher: Fetcher = fetch): Promise<Packument | undefined> {
  if (!isValidName(name))
    fail(`${name} is not a valid npm package name`)

  const response = await get(fetcher, `${registry.url.replace(TRAILING_SLASHES, '')}/${encodeURIComponent(name).replace('%40', '@').replace('%2F', '%2f')}`, registry.token)

  if (response.status === 404)
    return undefined

  if (!response.ok)
    unreachable(`${new URL(registry.url).host} answered ${response.status} for ${name}`)

  let packument

  try {
    packument = await response.json() as Packument
  }
  catch {
    return unreachable(`${new URL(registry.url).host} answered ${name} with something that is not JSON`)
  }

  if (packument?.name !== name)
    unreachable(`${new URL(registry.url).host} answered ${name} with the metadata of ${String(packument?.name)}`)

  return packument
}

// Weekly downloads from the public downloads API, undefined for a name it does not know or an answer it cannot read.
export async function fetchDownloads(name: string, fetcher: Fetcher = fetch): Promise<number | undefined> {
  const response = await get(fetcher, `${DOWNLOADS_API}/${encodeURIComponent(name)}`)

  if (!response.ok)
    return undefined

  try {
    return (await response.json() as { downloads?: number }).downloads
  }
  catch {
    return undefined
  }
}
