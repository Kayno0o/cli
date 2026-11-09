import type { AdvisoryRow, Severity } from '@kaynooo/cli-kit'
import type { Finding } from './report'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pool, severityRank } from '@kaynooo/cli-kit'
import { fixedAt } from './report'

const OSV = 'https://api.osv.dev/v1'
const BATCH = 1000
const DETAIL_CONCURRENCY = 8
const TIMEOUT_MS = 20_000
const PACKAGE_BLOCK = /^\[\[package\]\]\s*$/m
const FIELD = /^(name|version|source) = (.+)$/gm
const QUOTED = /^"([^"]*)"$/
const LEADING_V = /^v/

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface Locked {
  name: string
  version: string
  /** False for a composer `packages-dev` entry. */
  prod: boolean
}

interface Ecosystem {
  lockfile: string
  osv: string
  parse: (text: string) => Locked[]
}

interface ComposerEntry {
  name: string
  version: string
}

/** The composer.lock entries; a `v` before a version is dropped, as Packagist stores them without. */
export function parseComposerLock(text: string): Locked[] {
  const lock = JSON.parse(text) as { 'packages'?: ComposerEntry[], 'packages-dev'?: ComposerEntry[] }
  const entry = (prod: boolean) => (each: ComposerEntry): Locked => ({ name: each.name, version: each.version.replace(LEADING_V, ''), prod })

  return [...(lock.packages ?? []).map(entry(true)), ...(lock['packages-dev'] ?? []).map(entry(false))]
}

/** The `[[package]]` tables of a TOML lockfile that come from a registry, so not the project itself or a path or git source. */
function tomlPackages(text: string, fromRegistry: (source: string) => boolean): Locked[] {
  const found: Locked[] = []

  for (const block of text.split(PACKAGE_BLOCK).slice(1)) {
    const fields = new Map<string, string>()

    for (const [, key, value] of block.matchAll(FIELD))
      fields.set(key!, QUOTED.exec(value!.trim())?.[1] ?? value!.trim())

    const source = fields.get('source')
    const name = fields.get('name')
    const version = fields.get('version')

    if (name !== undefined && version !== undefined && source !== undefined && fromRegistry(source))
      found.push({ name, version, prod: true })
  }

  return found
}

export function parseCargoLock(text: string): Locked[] {
  return tomlPackages(text, source => source.startsWith('registry+'))
}

// A uv source is `{ registry = "..." }` for an index, `{ virtual = "." }` or `{ editable = "." }` for the project itself.
export function parseUvLock(text: string): Locked[] {
  return tomlPackages(text, source => source.includes('registry'))
}

const ECOSYSTEMS: Ecosystem[] = [
  { lockfile: 'composer.lock', osv: 'Packagist', parse: parseComposerLock },
  { lockfile: 'Cargo.lock', osv: 'crates.io', parse: parseCargoLock },
  { lockfile: 'uv.lock', osv: 'PyPI', parse: parseUvLock },
]

export function holdsOsvLock(dir: string): boolean {
  return ECOSYSTEMS.some(each => existsSync(join(dir, each.lockfile)))
}

interface OsvVuln {
  id: string
  summary?: string
  database_specific?: { severity?: string }
  affected?: { package?: { name?: string }, ranges?: { events?: { fixed?: string }[] }[] }[]
}

const SEVERITY_NAMES: Record<string, Severity> = { LOW: 'low', MODERATE: 'moderate', MEDIUM: 'moderate', HIGH: 'high', CRITICAL: 'critical' }

async function ok(response: Response): Promise<unknown> {
  if (!response.ok)
    throw new Error(`osv.dev answered ${response.status}`)

  return response.json()
}

/** The row for one OSV vulnerability hitting `name`; it has no numeric id, so `ghsa` holds the OSV id (GHSA, RUSTSEC or PYSEC) for --ignore, and a severity the source leaves out reads as moderate. */
function rowOf(vuln: OsvVuln, name: string): AdvisoryRow {
  const fixes = (vuln.affected ?? []).filter(each => each.package?.name === name).flatMap(each => each.ranges ?? []).flatMap(range => range.events ?? []).map(event => event.fixed).filter(fixed => fixed !== undefined)

  return { id: 0, ghsa: vuln.id, url: `https://osv.dev/vulnerability/${vuln.id}`, title: vuln.summary ?? vuln.id, severity: SEVERITY_NAMES[vuln.database_specific?.severity?.toUpperCase() ?? ''] ?? 'moderate', fixed: fixes.length === 0 ? undefined : fixedAt(fixes.map(fix => `<${fix}`).join(' || ')) }
}

/** The findings of one lockfile through the OSV batch API, one per package, and how many advisories the level left out; `direct` holds the names the manifest asks for. */
export async function osvFindings(locked: Locked[], ecosystem: string, direct: ReadonlySet<string>, level: Severity, ignore: readonly string[], fetcher: Fetcher = fetch): Promise<{ findings: Finding[], below: number }> {
  const hits = new Map<Locked, string[]>()

  for (let start = 0; start < locked.length; start += BATCH) {
    const chunk = locked.slice(start, start + BATCH)
    const queries = chunk.map(each => ({ package: { name: each.name, ecosystem }, version: each.version }))
    const answer = await ok(await fetcher(`${OSV}/querybatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries }), signal: AbortSignal.timeout(TIMEOUT_MS) })) as { results: { vulns?: { id: string }[] }[] }

    for (const [index, each] of chunk.entries()) {
      const ids = (answer.results[index]?.vulns ?? []).map(vuln => vuln.id).filter(id => !ignore.includes(id))

      if (ids.length > 0)
        hits.set(each, ids)
    }
  }

  const details = new Map<string, OsvVuln>()

  await pool([...new Set([...hits.values()].flat())], DETAIL_CONCURRENCY, async (id) => {
    details.set(id, await ok(await fetcher(`${OSV}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })) as OsvVuln)
  })

  const findings: Finding[] = []
  let below = 0

  for (const [each, ids] of hits) {
    const rows = ids.map(id => rowOf(details.get(id)!, each.name))
    const advisories = rows.filter(row => severityRank(row.severity) >= severityRank(level))

    below += rows.length - advisories.length

    if (advisories.length === 0)
      continue

    const fixes = advisories.map(row => row.fixed)

    findings.push({
      package: each.name,
      severity: advisories.reduce((worst, row) => severityRank(row.severity) > severityRank(worst) ? row.severity : worst, advisories[0]!.severity),
      advisories,
      scope: each.prod ? 'prod' : 'dev',
      direct: direct.has(each.name),
      via: [],
      fix: fixes.includes(undefined) ? undefined : (fixes as string[]).reduce((highest, fix) => Bun.semver.order(fix, highest) > 0 ? fix : highest),
    })
  }

  return { findings: findings.toSorted((a, b) => severityRank(b.severity) - severityRank(a.severity) || Number(b.scope === 'prod') - Number(a.scope === 'prod') || a.package.localeCompare(b.package)), below }
}

function manifestNames(dir: string): Set<string> {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'composer.json'), 'utf8')) as { 'require'?: object, 'require-dev'?: object }

    return new Set([...Object.keys(manifest.require ?? {}), ...Object.keys(manifest['require-dev'] ?? {})])
  }
  catch {
    return new Set()
  }
}

/** The findings of every composer, Cargo and uv lockfile in a repository; only composer's manifest says what is direct, the others read as pulled in. */
export async function osvAudit(dir: string, level: Severity, ignore: readonly string[], fetcher: Fetcher = fetch): Promise<{ findings: Finding[], below: number }> {
  const all: { findings: Finding[], below: number } = { findings: [], below: 0 }

  for (const each of ECOSYSTEMS.filter(each => existsSync(join(dir, each.lockfile)))) {
    const done = await osvFindings(each.parse(readFileSync(join(dir, each.lockfile), 'utf8')), each.osv, each.lockfile === 'composer.lock' ? manifestNames(dir) : new Set(), level, ignore, fetcher)

    all.findings.push(...done.findings)
    all.below += done.below
  }

  return all
}
