import { fail } from '@kaynooo/cli-kit'

export const PUBLIC_REGISTRY = 'https://registry.npmjs.org'
const DOWNLOADS_API = 'https://api.npmjs.org/downloads/point/last-week'
const TRAILING_SLASHES = /\/+$/

export interface Registry {
  url: string
  token?: string | undefined
}

export interface Version {
  version: string
  scripts?: Record<string, string>
  deprecated?: string
  license?: string | { type?: string }
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

async function get(fetcher: Fetcher, url: string, token?: string): Promise<Response> {
  try {
    return await fetcher(url, { headers: { accept: 'application/json', ...token === undefined ? {} : { authorization: `Bearer ${token}` } } })
  }
  catch (error) {
    return fail(`cannot reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`, 1)
  }
}

// The full metadata document, which carries the publish times and licence that the abbreviated one leaves out; undefined when the registry has no such package.
export async function fetchPackument(name: string, registry: Registry, fetcher: Fetcher = fetch): Promise<Packument | undefined> {
  const response = await get(fetcher, `${registry.url.replace(TRAILING_SLASHES, '')}/${name.replace('/', '%2f')}`, registry.token)

  if (response.status === 404)
    return undefined

  if (!response.ok)
    fail(`${new URL(registry.url).host} answered ${response.status} for ${name}`, 1)

  return await response.json() as Packument
}

// Weekly downloads from the public downloads API, undefined for a name it does not know.
export async function fetchDownloads(name: string, fetcher: Fetcher = fetch): Promise<number | undefined> {
  const response = await get(fetcher, `${DOWNLOADS_API}/${name}`)

  if (!response.ok)
    return undefined

  const body = await response.json() as { downloads?: number }

  return body.downloads
}
