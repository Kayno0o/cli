import type { ExitRow } from '@kaynooo/cli-kit'
import type { Progress } from '@kaynooo/cli-kit/progress'
import type { Advisory, VersionAdvisory } from '../advisories'
import type { PkgSettings, RegistryConfig, Severity } from '../config'
import type { Locked } from '../lockfile'
import type { Fetcher, Packument, Registry } from '../registry'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, parse, pool, printJson, role, warn, wholeNumber } from '@kaynooo/cli-kit'
import { progressLine } from '@kaynooo/cli-kit/progress'
import { advisoriesFor, fetchAdvisories, filterAdvisories } from '../advisories'
import { analyze, DEFAULT_MIN_AGE_DAYS } from '../analyze'
import { DEFAULT_BLOCK_SEVERITY, loadConfigs, loadSettings, registryFor, SEVERITIES } from '../config'
import { parseBunLock, productionPackages } from '../lockfile'
import { fetchPackument } from '../registry'

const usage = `pkg audit [dir]

Reads the bun.lock in the folder (the current one by default) and runs on every registry package it pins the checks \`pkg check\` runs before an add: age, install scripts, a deprecated version, a changed publisher or lost attestation, a near miss of a popular name, and the licence allowlist of the pkg config. It also lists the known advisories of each version, with the GHSA, the severity and the fixed version, from the registry's bulk advisory endpoint, the one \`bun audit\` reads.
Findings are grouped per package, each registry package looked up once per run.
Reach for it to vet one repository in depth; \`audit\` sweeps many repositories for advisories only, and shares --level, --prod and --ignore.`

const EXITS: ExitRow[] = [[0, 'nothing blocks'], [1, 'a package is missing, too fresh or outside the licence allowlist, or an advisory reaches --level'], [2, 'the registry could not be reached or answered badly (a warning says which, and nothing is reported as clean), a usage error or no bun.lock']]

const options = {
  'json': jsonOption('[{name, version, license, blocked, warnings, advisories}] for the packages with a finding'),
  'min-age': { type: 'string', description: `days a version must be old (${DEFAULT_MIN_AGE_DAYS}, or the minAge setting)` },
  'level': { type: 'string', choices: SEVERITIES, default: 'moderate', description: 'lowest advisory severity listed and failing (moderate)' },
  'prod': { type: 'boolean', description: 'only the packages a production dependency or an optional one of a workspace reaches' },
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
  // Hears each step and how many packages were looked up, for a progress line.
  onProgress?: ((progress: Progress) => void) | undefined
}

export interface Audited {
  name: string
  version: string
  license?: string | undefined
  blocked: boolean
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
    const input = { spec: { name, request: version }, packument: await lookup(name, registry), registry: new URL(registry.url).host, now: context.now, minAgeDays: context.minAgeDays, licenses: context.settings.licenses }

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

    return { name, version, license: report.license, blocked: report.blocked || found.length > 0, warnings: report.warnings, advisories: found }
  })

  return { audited, unavailable }
}

const HIGH_SEVERITIES = new Set<string>(['high', 'critical'])

export function renderAudit(findings: Audited[], total: number, stream: { isTTY?: boolean } = process.stdout, env: Record<string, string | undefined> = process.env): string {
  const id = role('id', stream, env)
  const label = role('label', stream, env)
  const warning = role('warn', stream, env)
  const problem = role('problem', stream, env)
  const blocking = findings.filter(each => each.blocked).length
  const blocks = findings.map(({ name, version, warnings, advisories }) => [
    id(`${name}@${version}`),
    ...warnings.map(each => `  ${warning('warning:')} ${each}`),
    ...advisories.map(each => `  ${label(String(each.ghsa ?? each.id))} ${(HIGH_SEVERITIES.has(each.severity) ? problem : warning)(each.severity)}: ${each.title}${each.fixed === undefined ? '' : ` ${label(`(fixed in ${each.fixed})`)}`}`),
  ].join('\n'))

  return [...blocks, `${findings.length} of ${total} packages with a finding, ${(blocking === 0 ? label : problem)(`${blocking} blocking`)}`].join('\n\n')
}

export async function audit(args: string[]): Promise<number> {
  const { values, positionals: [asked] } = parse(args, usage, options, { positionals: ['[dir]'], exits: EXITS })
  const { level } = values

  const dir = resolve(asked ?? process.cwd())
  const lock = Bun.file(join(dir, 'bun.lock'))

  if (!await lock.exists())
    fail(`no bun.lock in ${dir}`)

  const text = await lock.text()
  const production = values.prod === true ? productionPackages(text) : undefined
  const packages = parseBunLock(text).filter(({ name, version }) => production?.has(`${name}@${version}`) ?? true)
  const settings = await loadSettings(dir)
  const context: AuditContext = {
    configs: await loadConfigs(dir),
    settings,
    minAgeDays: wholeNumber(values['min-age'], 'min-age', settings.minAge ?? DEFAULT_MIN_AGE_DAYS, 0),
    level,
    ignore: values.ignore ?? [],
  }
  const progress = progressLine()
  let result: Audit

  try {
    result = await auditPackages(packages, { ...context, onProgress: progress.update })
  }
  finally {
    progress.stop()
  }

  const { audited, unavailable } = result
  const findings = audited.filter(hasFinding)

  if (values.json === true)
    printJson(findings)
  else
    console.log(renderAudit(findings, packages.length))

  for (const reason of unavailable)
    warn(`${reason}, so its advisories are not checked`)

  if (findings.some(each => each.blocked))
    return 1

  return unavailable.length > 0 ? 2 : 0
}
