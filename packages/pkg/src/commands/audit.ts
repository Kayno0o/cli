import type { ExitRow } from '@kaynooo/cli-kit'
import type { Progress } from '@kaynooo/cli-kit/progress'
import type { Advisory, VersionAdvisory } from '../advisories'
import type { PkgSettings, RegistryConfig, Severity } from '../config'
import type { Locked } from '../lockfile'
import type { Fetcher, Packument, Registry } from '../registry'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, parse, pool, printJson, role, warn, wholeNumber, writeErr } from '@kaynooo/cli-kit'
import { detectLockfiles, directDependenciesOf, JS_LOCKFILES, lockGraphFromBun, OSV_LOCKFILES, osvAuditLockfiles, reachedFrom } from '@kaynooo/cli-kit/audit'
import { progressLine } from '@kaynooo/cli-kit/progress'
import { advisoriesFor, fetchAdvisories, filterAdvisories } from '../advisories'
import { analyze, DEFAULT_MIN_AGE_DAYS } from '../analyze'
import { DEFAULT_BLOCK_SEVERITY, loadConfigs, loadSettings, registryFor, SEVERITIES } from '../config'
import { productionPackages } from '../lockfile'
import { fetchPackument } from '../registry'
import { nearestFolder } from '../root'

const usage = `pkg audit [dir]

Reads the lockfile(s) of the folder, or of the nearest folder above it that has one (bun.lock, pnpm-lock.yaml, yarn.lock, package-lock.json, composer.lock, Cargo.lock, uv.lock), runs safety vetting + advisory checks with direct/via attribution, and lists every finding.
Reach for it to vet one repository in depth; \`ws audit\` sweeps many repositories at once.`

const EXITS: ExitRow[] = [[0, 'nothing blocks'], [1, 'a package is missing, too fresh or outside the licence allowlist, or an advisory reaches --level'], [2, 'the registry could not be reached or answered badly (a warning says which, and nothing is reported as clean), a usage error or no lockfile']]

const options = {
  'json': jsonOption('[{name, version, license, blocked, direct, via, warnings, advisories}] for the packages with a finding'),
  'min-age': { type: 'string', description: `days a version must be old (${DEFAULT_MIN_AGE_DAYS}, or the minAge setting)` },
  'level': { type: 'string', choices: SEVERITIES, default: 'moderate', description: 'lowest advisory severity listed and failing (moderate)' },
  'prod': { type: 'boolean', description: 'only the packages a production dependency or an optional one reaches' },
  'ignore': { type: 'string', multiple: true, description: 'an advisory skipped by GHSA or numeric id, repeatable' },
} as const

const BATCH = 8

export interface AuditContext {
  configs: RegistryConfig[]
  settings: PkgSettings
  minAgeDays: number
  level: Severity
  ignore: string[]
  fetcher?: Fetcher | undefined
  now?: number | undefined
  direct?: ReadonlySet<string> | undefined
  via?: ReadonlyMap<string, string[]> | undefined
  // Hears each step and how many packages were looked up, for a progress line.
  onProgress?: ((progress: Progress) => void) | undefined
}

export interface Audited {
  name: string
  version: string
  license?: string | undefined
  blocked: boolean
  direct?: boolean | undefined
  via?: string[] | undefined
  warnings: string[]
  advisories: VersionAdvisory[]
}

function hasFinding(audited: Audited): boolean {
  return audited.blocked || audited.warnings.length > 0 || audited.advisories.length > 0
}

export interface Audit {
  audited: Audited[]
  // What stopped the advisories of a registry from being read, so that "no advisory" is not taken for "none known".
  unavailable: string[]
}

// Every locked package through the same analysis as `pkg check`, one registry lookup per name and one advisory request per registry.
export async function auditPackages(packages: Locked[], context: AuditContext): Promise<Audit> {
  const packuments = new Map<string, Promise<Packument | undefined>>()
  const lookup = async (name: string, registry: Registry): Promise<Packument | undefined> => {
    const key = `${registry.url}|${name}`

    if (!packuments.has(key))
      packuments.set(key, fetchPackument(name, registry, context.fetcher))

    return packuments.get(key)
  }
  const looked = await pool(packages, context.settings.concurrency ?? BATCH, async ({ name, version }) => {
    const registry = registryFor(name, context.configs)
    const input = { spec: { name, request: version }, packument: await lookup(name, registry), registry: new URL(registry.url).host, now: context.now, minAgeDays: context.minAgeDays, licenses: context.settings.licenses, trusted: context.settings.trusted }

    return { name, version, registry, input, safe: analyze(input).safe?.version }
  }, (done, total) => context.onProgress?.({ step: 'looking up', done, total, unit: 'packages' }))

  context.onProgress?.({ step: 'reading the advisories' })

  const registries = new Map<string, { registry: Registry, versions: Record<string, string[]> }>()

  for (const { name, version, registry, safe } of looked) {
    const group = registries.get(registry.url) ?? { registry, versions: {} }

    // The safe version is asked about too, so a fresh pin fixing its advisories is not held back for its age.
    group.versions[name] = [...group.versions[name] ?? [], version, ...safe === undefined || safe === version ? [] : [safe]]
    registries.set(registry.url, group)
  }

  const advisories: Record<string, Advisory[]> = {}
  const unavailable: string[] = []

  for (const { registry, versions } of registries.values()) {
    const fetched = await fetchAdvisories(versions, registry, context.fetcher)

    Object.assign(advisories, fetched.found)

    if (fetched.unavailable !== undefined)
      unavailable.push(fetched.unavailable)
  }

  const blockSeverity = context.settings.blockSeverity ?? DEFAULT_BLOCK_SEVERITY
  const audited = looked.map(({ name, version, input, safe }) => {
    const found = filterAdvisories(advisoriesFor(advisories[name], version), context.level, context.ignore)
    const safeAdvisories = safe === undefined ? [] : filterAdvisories(advisoriesFor(advisories[name], safe), blockSeverity, context.ignore)
    const report = analyze({ ...input, advisories: advisoriesFor(advisories[name], version), safeAdvisories })
    const isDirect = context.direct?.has(name)
    const via = isDirect === true ? [] : context.via?.get(name)

    return {
      name,
      version,
      license: report.license,
      blocked: report.blocked || found.length > 0,
      ...isDirect === undefined ? {} : { direct: isDirect },
      ...via === undefined ? {} : { via },
      warnings: report.warnings,
      advisories: found,
    }
  })

  return { audited, unavailable }
}

const HIGH_SEVERITIES = new Set<string>(['high', 'critical'])

function originTag(entry: Audited): string {
  if (entry.direct === true)
    return ' (direct)'

  return entry.via !== undefined && entry.via.length > 0 ? ` (via ${entry.via.slice(0, 2).join(', ')})` : ''
}

export function renderAudit(findings: Audited[], total: number, stream: { isTTY?: boolean } = process.stdout, env: Record<string, string | undefined> = process.env): string {
  const id = role('id', stream, env)
  const label = role('label', stream, env)
  const warning = role('warn', stream, env)
  const problem = role('problem', stream, env)
  const blocking = findings.filter(each => each.blocked).length
  const blocks = findings.map(entry => [
    `${id(`${entry.name}@${entry.version}`)}${label(originTag(entry))}`,
    ...entry.warnings.map(each => `  ${warning('warning:')} ${each}`),
    ...entry.advisories.map(each => `  ${label(String(each.ghsa ?? each.id))} ${(HIGH_SEVERITIES.has(each.severity) ? problem : warning)(each.severity)}: ${each.title}${each.fixed === undefined ? '' : ` ${label(`(fixed in ${each.fixed})`)}`}`),
  ].join('\n'))

  return [...blocks, `${findings.length} of ${total} packages with a finding, ${(blocking === 0 ? label : problem)(`${blocking} blocking`)}`].join('\n\n')
}

export async function audit(args: string[]): Promise<number> {
  const { values, positionals: [asked] } = parse(args, usage, options, { positionals: ['[dir]'], exits: EXITS })
  const { level } = values

  const from = resolve(asked ?? process.cwd())
  const dir = nearestFolder(from, folder => detectLockfiles(folder).length > 0)

  if (dir === undefined)
    fail(`no lockfile (bun.lock, pnpm-lock.yaml, yarn.lock, package-lock.json, composer.lock, Cargo.lock or uv.lock) in ${from} or above`)

  if (dir !== from)
    writeErr(`using the lockfile in ${dir}`)

  const jsLock = JS_LOCKFILES.find(spec => existsSync(join(dir, spec.file)))
  const osvLocks = OSV_LOCKFILES.filter(spec => existsSync(join(dir, spec.file)))
  const settings = await loadSettings(dir)
  const progress = progressLine()
  const audited: Audited[] = []
  const unavailable: string[] = []
  let totalCount = 0

  try {
    if (jsLock !== undefined) {
      const text = readFileSync(join(dir, jsLock.file), 'utf8')
      const production = values.prod === true && jsLock.file === 'bun.lock' ? productionPackages(text) : undefined
      const parsed = jsLock.parse(text).filter(pkg => (values.prod !== true || pkg.prod) && (production?.has(`${pkg.name}@${pkg.version}`) ?? true))
      const direct = directDependenciesOf(dir, 'npm')
      const via = jsLock.file === 'bun.lock' ? reachedFrom(lockGraphFromBun(text), direct, new Set(parsed.map(pkg => pkg.name))) : new Map<string, string[]>()

      totalCount += parsed.length

      const context: AuditContext = {
        configs: await loadConfigs(dir),
        settings,
        minAgeDays: wholeNumber(values['min-age'], 'min-age', settings.minAge ?? DEFAULT_MIN_AGE_DAYS, 0),
        level,
        ignore: values.ignore ?? [],
        direct,
        via,
        onProgress: progress.update,
      }
      const jsResult = await auditPackages(parsed, context)

      audited.push(...jsResult.audited)
      unavailable.push(...jsResult.unavailable)
    }

    if (osvLocks.length > 0) {
      progress.update({ step: 'querying osv.dev' })

      for (const spec of osvLocks)
        totalCount += spec.parse(readFileSync(join(dir, spec.file), 'utf8')).length

      try {
        const osv = await osvAuditLockfiles(dir, osvLocks, level, values.ignore ?? [])

        for (const finding of osv.findings) {
          if (values.prod === true && finding.scope !== 'prod')
            continue

          audited.push({
            name: finding.package,
            version: finding.fix ?? '*',
            blocked: true,
            direct: finding.direct,
            via: finding.via,
            warnings: [],
            advisories: finding.advisories.map(row => ({ ...row, vulnerable: row.fixed === undefined ? '*' : `<${row.fixed}` })),
          })
        }
      }
      catch (error) {
        unavailable.push(`osv.dev: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  finally {
    progress.stop()
  }

  const findings = audited.filter(hasFinding)

  if (values.json === true)
    printJson(findings)
  else
    console.log(renderAudit(findings, totalCount))

  for (const reason of unavailable)
    warn(`${reason}, so its advisories are not checked`)

  if (findings.some(each => each.blocked))
    return 1

  return unavailable.length > 0 ? 2 : 0
}
