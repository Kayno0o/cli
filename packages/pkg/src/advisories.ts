import type { Severity } from './config'
import type { Fetcher, Registry } from './registry'
import { SEVERITIES } from './config'

// The npm bulk advisory endpoint, the one `bun audit` posts to: a JSON body of `{ name: [version, ...] }` answered with `{ name: [advisory, ...] }`, only the advisories whose range matches a version sent.
const BULK_PATH = '/-/npm/v1/security/advisories/bulk'
const TRAILING_SLASHES = /\/+$/
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
  const range = vulnerable.split('||').map(each => each.trim()).find(each => Bun.semver.satisfies(version, each))

  return range === undefined ? undefined : UPPER_BOUND.exec(range)?.[1]
}

// The advisories hitting each name@version, empty when the registry has no such endpoint; the request is one POST for every name given.
export async function fetchAdvisories(versions: Record<string, string[]>, registry: Registry, fetcher: Fetcher = fetch): Promise<Record<string, Advisory[]>> {
  const url = `${registry.url.replace(TRAILING_SLASHES, '')}${BULK_PATH}`
  let response

  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/json', ...registry.token === undefined ? {} : { authorization: `Bearer ${registry.token}` } },
      body: JSON.stringify(versions),
    })
  }
  catch {
    return {}
  }

  if (!response.ok)
    return {}

  const body = await response.json() as Record<string, RawAdvisory[]>
  const found: Record<string, Advisory[]> = {}

  for (const [name, raws] of Object.entries(body)) {
    found[name] = raws.filter(raw => SEVERITIES.includes(raw.severity as Severity)).map(raw => ({
      id: raw.id,
      ghsa: GHSA.exec(raw.url)?.[0],
      url: raw.url,
      title: raw.title,
      severity: raw.severity as Severity,
      vulnerable: raw.vulnerable_versions,
    }))
  }

  return found
}

// The advisories whose range covers the version, each with the version that fixes it.
export function advisoriesFor(advisories: Advisory[] | undefined, version: string): VersionAdvisory[] {
  return (advisories ?? []).filter(each => Bun.semver.satisfies(version, each.vulnerable)).map(each => ({ ...each, fixed: fixedVersion(each.vulnerable, version) }))
}

// The advisories at or above the level, minus those ignored by GHSA or numeric id.
export function filterAdvisories<T extends Advisory>(advisories: T[], level: Severity, ignore: string[] = []): T[] {
  return advisories.filter(each => severityRank(each.severity) >= severityRank(level) && !ignore.includes(each.ghsa ?? '') && !ignore.includes(String(each.id)))
}
