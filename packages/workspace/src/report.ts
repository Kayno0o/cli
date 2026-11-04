import type { AdvisoryRow, Severity } from '@kaynooo/cli-kit'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isIgnored, severityRank } from '@kaynooo/cli-kit'

export { SEVERITIES } from '@kaynooo/cli-kit'
export type { Severity } from '@kaynooo/cli-kit'

/** What `bun audit --json` lists per package. */
export interface Advisory {
  id: number
  url: string
  title: string
  severity: Severity
  vulnerable_versions: string
}

export interface Finding {
  package: string
  /** The worst of its advisories. */
  severity: Severity
  advisories: AdvisoryRow[]
  /** Whether the package is needed by a production dependency, else only by development ones. */
  scope: 'prod' | 'dev'
  /** Whether the repository's own package.json asks for the package, rather than a dependency of one. */
  direct: boolean
  /** The lowest version past every advisory, undefined when a range names no fixed version. */
  fix: string | undefined
}

const UPPER_BOUND = /<\s*(\d[\w.+-]*)/
const DEPENDENCY_KINDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

const GHSA = /GHSA-[\w-]+$/

/** The output of `bun audit --json`: undefined when it is no object of advisories. */
export function parseAudit(text: string): Record<string, Advisory[]> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, Advisory[]> : undefined
  }
  catch {
    return undefined
  }
}

/** The version a vulnerable range ends below (`<1.2.3` fixes at 1.2.3, `>=2.0.0 <2.4.1 || <1.9.9` at the highest of 2.4.1 and 1.9.9), undefined for one open-ended or ending at a version that is itself vulnerable (`<=1.2.3`). */
export function fixedAt(range: string): string | undefined {
  const bounds = range.split('||').map(part => UPPER_BOUND.exec(part)?.[1])

  if (bounds.length === 0 || bounds.includes(undefined))
    return undefined

  return (bounds as string[]).reduce((highest, bound) => Bun.semver.order(bound, highest) > 0 ? bound : highest)
}

/** The version past every advisory at once, undefined when one of them names none. */
export function fixFor(advisories: Advisory[]): string | undefined {
  const fixes = advisories.map(advisory => fixedAt(advisory.vulnerable_versions))

  if (fixes.length === 0 || fixes.includes(undefined))
    return undefined

  return (fixes as string[]).reduce((highest, fix) => Bun.semver.order(fix, highest) > 0 ? fix : highest)
}

/** The audit as one finding per package, the worst first; `reaching` holds the names the production audit lists and `direct` the ones package.json asks for. */
export function findingsOf(audit: Record<string, Advisory[]>, reaching: ReadonlySet<string>, direct: ReadonlySet<string>, level: Severity, ignore: readonly string[] = []): Finding[] {
  const found: Finding[] = []

  for (const [name, all] of Object.entries(audit)) {
    const kept = all.filter(advisory => severityRank(advisory.severity) >= severityRank(level) && !isIgnored({ id: advisory.id, ghsa: GHSA.exec(advisory.url)?.[0] }, ignore))

    if (kept.length === 0)
      continue

    const advisories = kept.map((advisory): AdvisoryRow => ({ id: advisory.id, ghsa: GHSA.exec(advisory.url)?.[0], url: advisory.url, title: advisory.title, severity: advisory.severity, fixed: fixedAt(advisory.vulnerable_versions) }))

    found.push({
      package: name,
      severity: advisories.reduce((worst, advisory) => severityRank(advisory.severity) > severityRank(worst) ? advisory.severity : worst, advisories[0]!.severity),
      advisories,
      scope: reaching.has(name) ? 'prod' : 'dev',
      direct: direct.has(name),
      fix: fixFor(kept),
    })
  }

  return found.toSorted((a, b) => severityRank(b.severity) - severityRank(a.severity) || Number(b.scope === 'prod') - Number(a.scope === 'prod') || a.package.localeCompare(b.package))
}

function readManifest(path: string): Record<string, unknown> {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function namesIn(manifest: Record<string, unknown>): string[] {
  return DEPENDENCY_KINDS.flatMap((kind) => {
    const section = manifest[kind]

    return typeof section === 'object' && section !== null ? Object.keys(section) : []
  })
}

/** The packages the repository's package.json and those of its workspaces ask for. */
export function directDependencies(root: string, workspaces: string[]): Set<string> {
  const names = new Set(namesIn(readManifest(join(root, 'package.json'))))

  for (const workspace of workspaces) {
    for (const name of namesIn(readManifest(join(root, workspace, 'package.json'))))
      names.add(name)
  }

  return names
}

function workspacePatterns(field: unknown): unknown[] {
  if (Array.isArray(field))
    return field

  const packages = typeof field === 'object' && field !== null ? (field as { packages?: unknown }).packages : undefined

  return Array.isArray(packages) ? packages : []
}

/** The folders a `workspaces` field names, a trailing `/*` listing every folder under it is resolved by `children`. */
export function workspaceFolders(root: string, children: (folder: string) => string[]): string[] {
  const patterns = workspacePatterns(readManifest(join(root, 'package.json')).workspaces)

  return patterns.filter((pattern): pattern is string => typeof pattern === 'string').flatMap(pattern => pattern.endsWith('/*') ? children(pattern.slice(0, -2)).map(name => join(pattern.slice(0, -2), name)) : [pattern])
}
