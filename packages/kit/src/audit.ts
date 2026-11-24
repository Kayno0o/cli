import type { AdvisoryRow, Severity } from './advisory'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { severityRank } from './advisory'
import { pool } from './pool'

export type AuditFetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface LockedPackage {
  name: string
  version: string
  /** False for dev-only entries where the lockfile distinguishes them (e.g. composer packages-dev). */
  prod: boolean
}

export interface AuditFinding {
  package: string
  severity: Severity
  advisories: AdvisoryRow[]
  scope: 'prod' | 'dev'
  direct: boolean
  via: string[]
  fix: string | undefined
}

export interface LockfileSpec {
  file: string
  ecosystem: 'npm' | 'Packagist' | 'crates.io' | 'PyPI'
  parse: (text: string) => LockedPackage[]
}

const OSV_API = 'https://api.osv.dev/v1'
const OSV_BATCH = 1000
const DETAIL_CONCURRENCY = 8
const TIMEOUT_MS = 20_000

const NOT_REGISTRY = /^(?:workspace|link|file|github|git|http|https):|^[\w.-]+\/[\w.-]+$/
const VERSION_SEPARATOR = /(?<=.)@/
const NPM_ALIAS = 'npm:'
const PACKAGE_BLOCK = /^\[\[package\]\]\s*$/m
const TOML_FIELD = /^(name|version|source) = (.+)$/gm
const QUOTED = /^"([^"]*)"$/
const LEADING_V = /^v/
const UPPER_BOUND = /<\s*(\d[\w.+-]*)/
const PNPM_SECTION = /^(?:packages|snapshots):$/m
const PNPM_KEY = /^ {2}['"]?\/?(@?[^@\s'":(]+)@(\d[^(\s'":]*)(?:\([^:]*\))?['"]?:$/gm
const YARN_HEADER = /^"?(@?[^@\s",:]+)@[^:\n]+:/gm
const YARN_VERSION = /^ {2}version(?::|\s)+["']?([^"'\s]+)["']?/m
const CARGO_SECTION_SPLIT = /^\[/m
const CARGO_DEP_SECTION = /^(?:dev-|build-)?dependencies\]/i
const CARGO_DEP = /^([a-z0-9_-]+)\s*=/gm
const PYPROJECT_DEP = /"([\w.-]+)(?:\[[^\]]*\])?(?:[<>=!~;\s]|$)/g
const DEPENDENCY_KINDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
const SEVERITY_NAMES: Record<string, Severity> = { LOW: 'low', MODERATE: 'moderate', MEDIUM: 'moderate', HIGH: 'high', CRITICAL: 'critical' }

function splitBunResolution(resolution: string): { name: string, version: string } | undefined {
  const at = resolution.search(VERSION_SEPARATOR)

  if (at === -1)
    return undefined

  const target = resolution.slice(at + 1)

  if (target.startsWith(NPM_ALIAS))
    return splitBunResolution(target.slice(NPM_ALIAS.length))

  return NOT_REGISTRY.test(target) ? undefined : { name: resolution.slice(0, at), version: target }
}

function dedupeLocked(items: LockedPackage[]): LockedPackage[] {
  const seen = new Map<string, LockedPackage>()

  for (const item of items) {
    const key = `${item.name}@${item.version}`
    const prev = seen.get(key)

    if (prev === undefined || (!prev.prod && item.prod))
      seen.set(key, item)
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || Bun.semver.order(a.version, b.version))
}

export function parseBunLock(text: string): LockedPackage[] {
  const lock = Bun.JSONC.parse(text) as { packages?: Record<string, unknown[]> } | null
  const items: LockedPackage[] = []

  for (const entry of Object.values(lock?.packages ?? {})) {
    const resolution = entry[0]

    if (typeof resolution !== 'string')
      continue

    const locked = splitBunResolution(resolution)

    if (locked !== undefined)
      items.push({ ...locked, prod: true })
  }

  return dedupeLocked(items)
}

export function parsePackageLock(text: string): LockedPackage[] {
  const lock = JSON.parse(text) as {
    packages?: Record<string, { version?: string, dev?: boolean, link?: boolean }>
    dependencies?: Record<string, { version?: string, dev?: boolean }>
  }
  const items: LockedPackage[] = []

  if (lock.packages !== undefined) {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key === '' || entry.link === true || entry.version === undefined)
        continue

      const marker = key.lastIndexOf('node_modules/')

      if (marker === -1)
        continue

      const name = key.slice(marker + 'node_modules/'.length)

      if (name !== '')
        items.push({ name, version: entry.version, prod: entry.dev !== true })
    }
  }
  else if (lock.dependencies !== undefined) {
    for (const [name, entry] of Object.entries(lock.dependencies)) {
      if (entry.version !== undefined)
        items.push({ name, version: entry.version, prod: entry.dev !== true })
    }
  }

  return dedupeLocked(items)
}

export function parsePnpmLock(text: string): LockedPackage[] {
  const sectionStart = text.search(PNPM_SECTION)

  if (sectionStart === -1)
    return []

  const body = text.slice(sectionStart)
  const items: LockedPackage[] = []

  for (const match of body.matchAll(PNPM_KEY)) {
    const name = match[1]
    const version = match[2]

    if (name !== undefined && version !== undefined && !version.startsWith('link:') && !version.startsWith('file:'))
      items.push({ name, version, prod: true })
  }

  return dedupeLocked(items)
}

export function parseYarnLock(text: string): LockedPackage[] {
  const items: LockedPackage[] = []
  const blocks = text.split('\n\n')

  for (const block of blocks) {
    const header = YARN_HEADER.exec(block)

    YARN_HEADER.lastIndex = 0

    if (header === null)
      continue

    const versionMatch = YARN_VERSION.exec(block)

    if (versionMatch?.[1] !== undefined && header[1] !== undefined)
      items.push({ name: header[1], version: versionMatch[1], prod: true })
  }

  return dedupeLocked(items)
}

interface ComposerEntry { name: string, version: string }

export function parseComposerLock(text: string): LockedPackage[] {
  const lock = JSON.parse(text) as { 'packages'?: ComposerEntry[], 'packages-dev'?: ComposerEntry[] }
  const entry = (prod: boolean) => (each: ComposerEntry): LockedPackage => ({ name: each.name, version: each.version.replace(LEADING_V, ''), prod })

  return [...(lock.packages ?? []).map(entry(true)), ...(lock['packages-dev'] ?? []).map(entry(false))]
}

function parseTomlLock(text: string, fromRegistry: (source: string) => boolean): LockedPackage[] {
  const found: LockedPackage[] = []

  for (const block of text.split(PACKAGE_BLOCK).slice(1)) {
    const fields = new Map<string, string>()

    for (const [, key, value] of block.matchAll(TOML_FIELD))
      fields.set(key!, QUOTED.exec(value!.trim())?.[1] ?? value!.trim())

    const source = fields.get('source')
    const name = fields.get('name')
    const version = fields.get('version')

    if (name !== undefined && version !== undefined && source !== undefined && fromRegistry(source))
      found.push({ name, version, prod: true })
  }

  return found
}

export function parseCargoLock(text: string): LockedPackage[] {
  return parseTomlLock(text, source => source.startsWith('registry+'))
}

export function parseUvLock(text: string): LockedPackage[] {
  return parseTomlLock(text, source => source.includes('registry'))
}

export const JS_LOCKFILES: LockfileSpec[] = [
  { file: 'bun.lock', ecosystem: 'npm', parse: parseBunLock },
  { file: 'pnpm-lock.yaml', ecosystem: 'npm', parse: parsePnpmLock },
  { file: 'yarn.lock', ecosystem: 'npm', parse: parseYarnLock },
  { file: 'package-lock.json', ecosystem: 'npm', parse: parsePackageLock },
]

export const OSV_LOCKFILES: LockfileSpec[] = [
  { file: 'composer.lock', ecosystem: 'Packagist', parse: parseComposerLock },
  { file: 'Cargo.lock', ecosystem: 'crates.io', parse: parseCargoLock },
  { file: 'uv.lock', ecosystem: 'PyPI', parse: parseUvLock },
]

export const ALL_LOCKFILES: LockfileSpec[] = [...JS_LOCKFILES, ...OSV_LOCKFILES]

export function detectLockfiles(dir: string): LockfileSpec[] {
  return ALL_LOCKFILES.filter(spec => existsSync(join(dir, spec.file)))
}

export function holdsAnyLock(dir: string): boolean {
  return existsSync(join(dir, 'bun.lockb')) || detectLockfiles(dir).length > 0
}

export function lockGraphFromBun(lockText: string): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  let lock: { packages?: Record<string, unknown[]> } | null

  try {
    lock = Bun.JSONC.parse(lockText) as typeof lock
  }
  catch {
    return graph
  }

  for (const entry of Object.values(lock?.packages ?? {})) {
    const resolution = entry[0]
    const info = entry[2]

    if (typeof resolution !== 'string' || typeof info !== 'object' || info === null)
      continue

    const at = resolution.indexOf('@', 1)
    const name = at === -1 ? resolution : resolution.slice(0, at)
    const wanted = DEPENDENCY_KINDS.flatMap(kind => Object.keys((info as Record<string, Record<string, string> | undefined>)[kind] ?? {}))

    graph.set(name, [...new Set([...graph.get(name) ?? [], ...wanted])])
  }

  return graph
}

export function reachedFrom(graph: ReadonlyMap<string, string[]>, direct: ReadonlySet<string>, targets: ReadonlySet<string>): Map<string, string[]> {
  const from = new Map<string, string[]>()

  for (const start of direct) {
    const seen = new Set<string>([start])
    const queue = [start]

    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      if (name !== start && targets.has(name))
        from.set(name, [...from.get(name) ?? [], start])

      for (const next of graph.get(name) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
  }

  return new Map([...from].map(([name, starts]) => [name, starts.toSorted()]))
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function jsManifestNames(manifest: Record<string, unknown>): string[] {
  return DEPENDENCY_KINDS.flatMap((kind) => {
    const section = manifest[kind]

    return typeof section === 'object' && section !== null ? Object.keys(section) : []
  })
}

function workspaceDirs(root: string): string[] {
  const raw = readJsonFile(join(root, 'package.json')).workspaces
  let patterns: unknown[] = []

  if (Array.isArray(raw))
    patterns = raw
  else if (typeof raw === 'object' && raw !== null && Array.isArray((raw as { packages?: unknown }).packages))
    patterns = (raw as { packages: unknown[] }).packages

  return patterns.filter((each): each is string => typeof each === 'string').flatMap((pattern) => {
    if (!pattern.endsWith('/*'))
      return [pattern]

    const base = pattern.slice(0, -2)

    try {
      return readdirSync(join(root, base), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(base, entry.name))
    }
    catch {
      return []
    }
  })
}

export function directDependenciesOf(dir: string, ecosystem: LockfileSpec['ecosystem']): Set<string> {
  if (ecosystem === 'npm') {
    const names = new Set(jsManifestNames(readJsonFile(join(dir, 'package.json'))))

    for (const ws of workspaceDirs(dir)) {
      for (const name of jsManifestNames(readJsonFile(join(dir, ws, 'package.json'))))
        names.add(name)
    }

    return names
  }

  if (ecosystem === 'Packagist') {
    const manifest = readJsonFile(join(dir, 'composer.json')) as { 'require'?: object, 'require-dev'?: object }

    return new Set([...Object.keys(manifest.require ?? {}), ...Object.keys(manifest['require-dev'] ?? {})])
  }

  if (ecosystem === 'crates.io') {
    const names = new Set<string>()
    const path = join(dir, 'Cargo.toml')

    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8')
      const sections = text.split(CARGO_SECTION_SPLIT)

      for (const sec of sections) {
        if (CARGO_DEP_SECTION.test(sec)) {
          for (const match of sec.matchAll(CARGO_DEP)) {
            if (match[1] !== undefined)
              names.add(match[1])
          }
        }
      }
    }

    return names
  }

  // PyPI (pyproject.toml)
  const names = new Set<string>()
  const path = join(dir, 'pyproject.toml')

  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8')

    for (const match of text.matchAll(PYPROJECT_DEP)) {
      if (match[1] !== undefined)
        names.add(match[1].toLowerCase())
    }
  }

  return names
}

export function fixedVersionFromRange(range: string): string | undefined {
  const bounds = range.split('||').map(part => UPPER_BOUND.exec(part)?.[1])

  if (bounds.length === 0 || bounds.includes(undefined))
    return undefined

  return (bounds as string[]).reduce((highest, bound) => Bun.semver.order(bound, highest) > 0 ? bound : highest)
}

interface OsvVuln {
  id: string
  summary?: string
  database_specific?: { severity?: string }
  affected?: { package?: { name?: string }, ranges?: { events?: { fixed?: string }[] }[] }[]
}

async function osvOk(response: Response): Promise<unknown> {
  if (!response.ok)
    throw new Error(`osv.dev answered ${response.status}`)

  return response.json()
}

function osvRow(vuln: OsvVuln, name: string): AdvisoryRow {
  const fixes = (vuln.affected ?? []).filter(each => each.package?.name === name).flatMap(each => each.ranges ?? []).flatMap(range => range.events ?? []).map(event => event.fixed).filter((fixed): fixed is string => fixed !== undefined)

  return {
    id: 0,
    ghsa: vuln.id,
    url: `https://osv.dev/vulnerability/${vuln.id}`,
    title: vuln.summary ?? vuln.id,
    severity: SEVERITY_NAMES[vuln.database_specific?.severity?.toUpperCase() ?? ''] ?? 'moderate',
    fixed: fixes.length === 0 ? undefined : fixedVersionFromRange(fixes.map(fix => `<${fix}`).join(' || ')),
  }
}

export async function osvQueryLocked(
  locked: LockedPackage[],
  ecosystem: string,
  direct: ReadonlySet<string>,
  level: Severity,
  ignore: readonly string[],
  fetcher: AuditFetcher = fetch,
  viaMap: ReadonlyMap<string, string[]> = new Map(),
): Promise<{ findings: AuditFinding[], below: number }> {
  const hits = new Map<LockedPackage, string[]>()

  for (let start = 0; start < locked.length; start += OSV_BATCH) {
    const chunk = locked.slice(start, start + OSV_BATCH)
    const queries = chunk.map(each => ({ package: { name: each.name, ecosystem }, version: each.version }))
    const answer = await osvOk(await fetcher(`${OSV_API}/querybatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries }), signal: AbortSignal.timeout(TIMEOUT_MS) })) as { results: { vulns?: { id: string }[] }[] }

    for (const [index, each] of chunk.entries()) {
      const ids = (answer.results[index]?.vulns ?? []).map(vuln => vuln.id).filter(id => !ignore.includes(id))

      if (ids.length > 0)
        hits.set(each, ids)
    }
  }

  const details = new Map<string, OsvVuln>()

  await pool([...new Set([...hits.values()].flat())], DETAIL_CONCURRENCY, async (id) => {
    details.set(id, await osvOk(await fetcher(`${OSV_API}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })) as OsvVuln)
  })

  const findings: AuditFinding[] = []
  let below = 0

  for (const [each, ids] of hits) {
    const rows = ids.map(id => osvRow(details.get(id)!, each.name))
    const advisories = rows.filter(row => severityRank(row.severity) >= severityRank(level))

    below += rows.length - advisories.length

    if (advisories.length === 0)
      continue

    const fixes = advisories.map(row => row.fixed)
    const isDirect = direct.has(each.name) || direct.has(each.name.toLowerCase())

    findings.push({
      package: each.name,
      severity: advisories.reduce((worst, row) => severityRank(row.severity) > severityRank(worst) ? row.severity : worst, advisories[0]!.severity),
      advisories,
      scope: each.prod ? 'prod' : 'dev',
      direct: isDirect,
      via: isDirect ? [] : (viaMap.get(each.name) ?? []),
      fix: fixes.includes(undefined) ? undefined : (fixes as string[]).reduce((highest, fix) => Bun.semver.order(fix, highest) > 0 ? fix : highest),
    })
  }

  return {
    findings: findings.toSorted((a, b) => severityRank(b.severity) - severityRank(a.severity) || Number(b.scope === 'prod') - Number(a.scope === 'prod') || a.package.localeCompare(b.package)),
    below,
  }
}

export async function osvAuditLockfiles(
  dir: string,
  specs: readonly LockfileSpec[],
  level: Severity,
  ignore: readonly string[],
  fetcher: AuditFetcher = fetch,
): Promise<{ findings: AuditFinding[], below: number }> {
  const all: { findings: AuditFinding[], below: number } = { findings: [], below: 0 }

  for (const spec of specs) {
    const file = join(dir, spec.file)

    if (!existsSync(file))
      continue

    const text = readFileSync(file, 'utf8')
    const locked = spec.parse(text)

    if (locked.length === 0)
      continue

    const direct = directDependenciesOf(dir, spec.ecosystem)
    const via = spec.file === 'bun.lock' ? reachedFrom(lockGraphFromBun(text), direct, new Set(locked.map(each => each.name))) : new Map<string, string[]>()
    const done = await osvQueryLocked(locked, spec.ecosystem, direct, level, ignore, fetcher, via)

    all.findings.push(...done.findings)
    all.below += done.below
  }

  return all
}
