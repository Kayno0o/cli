import type { Advisory, VersionAdvisory } from '../advisories'
import type { PkgSettings, RegistryConfig, Severity } from '../config'
import type { Locked } from '../lockfile'
import type { Fetcher, Packument, Registry } from '../registry'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, parse, printJson, wholeNumber } from '@kaynooo/cli-kit'
import { advisoriesFor, fetchAdvisories, filterAdvisories } from '../advisories'
import { analyze, DEFAULT_MIN_AGE_DAYS } from '../analyze'
import { isSeverity, loadConfigs, loadSettings, registryFor, SEVERITIES } from '../config'
import { parseBunLock } from '../lockfile'
import { fetchPackument } from '../registry'

const usage = `pkg audit [dir]

Reads the bun.lock in the folder (the current one by default) and runs on every registry package it pins the checks \`pkg check\` runs before an add: age, install scripts, a deprecated version, a near miss of a popular name, and the licence allowlist of the pkg config. It also lists the known advisories of each version, with the GHSA, the severity and the fixed version, from the registry's bulk advisory endpoint, the one \`bun audit\` reads.
Findings are grouped per package, each registry package looked up once per run.

Exits 0 when nothing blocks, 1 when a package is missing, too fresh or outside the licence allowlist, or an advisory reaches --audit-level, 2 on a usage error or without a bun.lock.`

const options = {
  'json': jsonOption('[{name, version, license, blocked, warnings, advisories}] for the packages with a finding'),
  'min-age': { type: 'string', description: `days a version must be old (${DEFAULT_MIN_AGE_DAYS})` },
  'audit-level': { type: 'string', description: 'lowest advisory severity listed and failing: low, moderate, high, critical (low)' },
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

// Every locked package through the same analysis as `pkg check`, one registry lookup per name and one advisory request per registry.
export async function auditPackages(packages: Locked[], context: AuditContext): Promise<Audited[]> {
  const packuments = new Map<string, Promise<Packument | undefined>>()
  const lookup = async (name: string, registry: Registry): Promise<Packument | undefined> => {
    const key = `${registry.url}|${name}`

    if (!packuments.has(key))
      packuments.set(key, fetchPackument(name, registry, context.fetcher))

    return packuments.get(key)
  }
  const registries = new Map<string, { registry: Registry, versions: Record<string, string[]> }>()

  for (const { name, version } of packages) {
    const registry = registryFor(name, context.configs)
    const group = registries.get(registry.url) ?? { registry, versions: {} }

    group.versions[name] = [...group.versions[name] ?? [], version]
    registries.set(registry.url, group)
  }

  const advisories: Record<string, Advisory[]> = {}

  for (const { registry, versions } of registries.values())
    Object.assign(advisories, await fetchAdvisories(versions, registry, context.fetcher))

  const audited: Audited[] = []

  for (let start = 0; start < packages.length; start += BATCH) {
    audited.push(...await Promise.all(packages.slice(start, start + BATCH).map(async ({ name, version }) => {
      const registry = registryFor(name, context.configs)
      const found = filterAdvisories(advisoriesFor(advisories[name], version), context.level, context.ignore)
      const report = analyze({ spec: { name, request: version }, packument: await lookup(name, registry), registry: new URL(registry.url).host, now: context.now, minAgeDays: context.minAgeDays, licenses: context.settings.licenses })

      return { name, version, license: report.license, blocked: report.blocked || found.length > 0, warnings: report.warnings, advisories: found }
    })))
  }

  return audited
}

export function renderAudit(findings: Audited[], total: number): string {
  const blocks = findings.map(({ name, version, warnings, advisories }) => [
    `${name}@${version}`,
    ...warnings.map(warning => `  warning: ${warning}`),
    ...advisories.map(each => `  ${each.ghsa ?? each.id} ${each.severity}: ${each.title}${each.fixed === undefined ? '' : ` (fixed in ${each.fixed})`}`),
  ].join('\n'))

  return [...blocks, `${findings.length} of ${total} packages with a finding, ${findings.filter(each => each.blocked).length} blocking`].join('\n\n')
}

export async function audit(args: string[]): Promise<number> {
  const { values, positionals: [asked] } = parse(args, usage, options, { positionals: ['[dir]'] })
  const level = values['audit-level'] ?? 'low'

  if (!isSeverity(level))
    fail(`--audit-level takes ${SEVERITIES.join(', ')}, not ${level}`)

  const dir = resolve(asked ?? process.cwd())
  const lock = Bun.file(join(dir, 'bun.lock'))

  if (!await lock.exists())
    fail(`no bun.lock in ${dir}`)

  const packages = parseBunLock(await lock.text())
  const context: AuditContext = {
    configs: await loadConfigs(dir),
    settings: await loadSettings(dir),
    minAgeDays: wholeNumber(values['min-age'], 'min-age', DEFAULT_MIN_AGE_DAYS, 0),
    level,
    ignore: values.ignore ?? [],
  }
  const findings = (await auditPackages(packages, context)).filter(hasFinding)

  if (values.json === true)
    printJson(findings)
  else
    console.log(renderAudit(findings, packages.length))

  return findings.some(each => each.blocked) ? 1 : 0
}
