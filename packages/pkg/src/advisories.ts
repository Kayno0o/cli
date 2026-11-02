import type { Severity } from './config'
import type { Fetcher, Registry } from './registry'
import { SEVERITIES } from './config'
import { inRange } from './semver'

// The npm bulk advisory endpoint, the one `bun audit` posts to: a JSON body of `{ name: [version, ...] }` answered with `{ name: [advisory, ...] }`, only the advisories whose range matches a version sent.
const BULK_PATH = '/-/npm/v1/security/advisories/bulk'
const TRAILING_SLASHES = /\/+$/
const REQUEST_TIMEOUT = 10_000
const GHSA = /GHSA-[\w-]+$/
const UPPER_BOUND = /(?:^|\s)<([\w.+-]+)/

export interface Advisory {
  id: number
  ghsa?: string | undefined
  url: string
  title: string
  severity: Severity
  vulnerable: string
}

export interface VersionAdvisory extends Advisory {
  // The version the range stops at when it is an exclusive upper bound.
  fixed?: string | undefined
}

interface RawAdvisory {
  id: number
  url: string
  title: string
  severity: string
  vulnerable_versions: string
}

export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity)
}

// The version a vulnerable range stops at for the version asked, undefined for a `<=` or open range.
export function fixedVersion(vulnerable: string, version: string): string | undefined {
  const range = vulnerable.split('||').map(each => each.trim()).find(each => inRange(version, each))

  return range === undefined ? undefined : UPPER_BOUND.exec(range)?.[1]
}

export interface Advisories {
  found: Record<string, Advisory[]>
  // Why the lookup gave nothing: the registry could not be asked or answered badly. Absent when it answered, even with no advisory.
  unavailable?: string | undefined
  // The registry has no bulk advisory endpoint at all, so no advisory can be known from it.
  isUnsupported?: boolean | undefined
}

const NO_ENDPOINT = new Set([404, 405, 501])

// The advisories hitting each name@version; the request is one POST for every name given, and a lookup that fails says why instead of reading as no advisory.
export async function fetchAdvisories(versions: Record<string, string[]>, registry: Registry, fetcher: Fetcher = fetch): Promise<Advisories> {
  const url = `${registry.url.replace(TRAILING_SLASHES, '')}${BULK_PATH}`
  const host = new URL(registry.url).host
  let response

  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json', ...registry.token === undefined ? {} : { authorization: `Bearer ${registry.token}` } },
      body: JSON.stringify(versions),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    })
  }
  catch (error) {
    return { found: {}, unavailable: `cannot reach ${host} for advisories: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (NO_ENDPOINT.has(response.status))
    return { found: {}, isUnsupported: true, unavailable: `${host} has no advisory endpoint` }

  if (!response.ok)
    return { found: {}, unavailable: `${host} answered ${response.status} for advisories` }

  let body

  try {
    body = await response.json() as Record<string, RawAdvisory[]>
  }
  catch {
    return { found: {}, unavailable: `${host} answered advisories with something that is not JSON` }
  }

  const found: Record<string, Advisory[]> = {}

  for (const [name, raws] of Object.entries(body)) {
    if (!Array.isArray(raws))
      continue

    found[name] = raws.filter(raw => SEVERITIES.includes(raw.severity as Severity)).map(raw => ({
      id: raw.id,
      ghsa: GHSA.exec(raw.url)?.[0],
      url: raw.url,
      title: raw.title,
      severity: raw.severity as Severity,
      vulnerable: raw.vulnerable_versions,
    }))
  }

  return { found }
}

// The advisories whose range covers the version, each with the version that fixes it.
export function advisoriesFor(advisories: Advisory[] | undefined, version: string): VersionAdvisory[] {
  return (advisories ?? []).filter(each => inRange(version, each.vulnerable)).map(each => ({ ...each, fixed: fixedVersion(each.vulnerable, version) }))
}

// The advisories at or above the level, minus those ignored by GHSA or numeric id.
export function filterAdvisories<T extends Advisory>(advisories: T[], level: Severity, ignore: string[] = []): T[] {
  return advisories.filter(each => severityRank(each.severity) >= severityRank(level) && !ignore.includes(each.ghsa ?? '') && !ignore.includes(String(each.id)))
}
