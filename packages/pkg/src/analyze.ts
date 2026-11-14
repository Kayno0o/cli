import type { VersionAdvisory } from './advisories'
import type { Severity } from './config'
import type { Packument, Version } from './registry'
import { counted } from '@kaynooo/utils/text'
import { filterAdvisories } from './advisories'
import { isLicenseAllowed } from './licenses'
import { nearMisses } from './nearmiss'
import { PUBLIC_REGISTRY } from './registry'
import { isRange } from './semver'

export const DEFAULT_MIN_AGE_DAYS = 14
const DAY = 86_400_000
const PUBLIC_HOST = new URL(PUBLIC_REGISTRY).host
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const
const GIT_PREFIX = /^git\+/
const VERSION_SEPARATOR = /(?<=.)@/

export interface Spec {
  name: string
  request?: string | undefined
}

export interface Release {
  version: string
  published?: string | undefined
}

export interface Report {
  name: string
  registry: string
  exists: boolean
  description?: string | undefined
  requested?: string | undefined
  // The version the request resolves to, absent when nothing matches it.
  version?: string | undefined
  published?: string | undefined
  latest?: Release | undefined
  // The highest stable version at least the minimum age old.
  safe?: Release | undefined
  downloads?: number | undefined
  license?: string | undefined
  repository?: string | undefined
  deprecated?: string | undefined
  installScripts: Record<string, string>
  nearMisses: string[]
  advisories: VersionAdvisory[]
  // The advisories of the safe version that the resolved one is clear of: a fresh version fixing them is not held back for its age.
  fixes: VersionAdvisory[]
  warnings: string[]
  // True when the package is missing, the version does not resolve, it is too fresh, its licence is outside the allowlist or an advisory reaches the severity threshold.
  blocked: boolean
}

// Splits `name`, `name@1.2.3`, `@scope/name` and `@scope/name@latest`.
export function parseSpec(text: string): Spec {
  const at = text.search(VERSION_SEPARATOR)

  return at === -1 ? { name: text } : { name: text.slice(0, at), request: text.slice(at + 1) }
}

function isStable(version: string): boolean {
  return !version.includes('-')
}

// An exact version, a dist-tag, or the highest version a range matches.
function resolve(packument: Packument, request: string | undefined): string | undefined {
  const tags = packument['dist-tags'] ?? {}
  const versions = Object.keys(packument.versions ?? {})
  const wanted = request === undefined || request === '' ? 'latest' : request

  if (tags[wanted] !== undefined)
    return tags[wanted]

  if (versions.includes(wanted))
    return wanted

  if (!isRange(wanted))
    return undefined

  return versions.filter(version => Bun.semver.satisfies(version, wanted)).sort(Bun.semver.order).at(-1)
}

function licenseOf(license: string | { type?: string } | undefined): string | undefined {
  return typeof license === 'string' ? license : license?.type
}

function repositoryOf(packument: Packument): string | undefined {
  const repository = typeof packument.repository === 'string' ? packument.repository : packument.repository?.url

  return repository?.replace(GIT_PREFIX, '') ?? packument.homepage
}

function ageDays(published: string | undefined, now: number): number | undefined {
  const at = Date.parse(published ?? '')

  return Number.isNaN(at) ? undefined : (now - at) / DAY
}

function daysAgo(age: number): string {
  return age < 1 ? 'less than a day' : counted(Math.floor(age), 'day')
}

function installScriptsOf(version: Version | undefined): Record<string, string> {
  return Object.fromEntries(INSTALL_SCRIPTS.flatMap(name => version?.scripts?.[name] === undefined ? [] : [[name, version.scripts[name]]]))
}

function safeRelease(packument: Packument, now: number, minAgeDays: number): Release | undefined {
  const old = Object.keys(packument.versions ?? {}).filter(version => isStable(version) && (ageDays(packument.time?.[version], now) ?? 0) >= minAgeDays && packument.time?.[version] !== undefined)
  const version = old.sort(Bun.semver.order).at(-1)

  return version === undefined ? undefined : { version, published: packument.time?.[version] }
}

// The stable release just below the version, or the one just below it when it is a prerelease itself.
function previousRelease(packument: Packument, version: string): Version | undefined {
  const below = Object.keys(packument.versions ?? {}).filter(each => (isStable(each) || !isStable(version)) && Bun.semver.order(each, version) < 0).sort(Bun.semver.order).at(-1)

  return below === undefined ? undefined : packument.versions?.[below]
}

function publisherWarnings(packument: Packument, version: string): string[] {
  const current = packument.versions?.[version]
  const previous = previousRelease(packument, version)
  const warnings: string[] = []

  if (current === undefined || previous === undefined)
    return warnings

  const by = current._npmUser?.name
  const before = previous._npmUser?.name

  // A move from a person to trusted publishing is the safe direction; a move back to a person still warns.
  const toTrusted = current._npmUser?.trustedPublisher !== undefined && previous._npmUser?.trustedPublisher === undefined

  if (by !== undefined && before !== undefined && by !== before && !toTrusted)
    warnings.push(`${version} was published by ${by}, ${previous.version} by ${before}`)

  if (previous.dist?.attestations !== undefined && current.dist?.attestations === undefined)
    warnings.push(`${version} has no provenance attestation, ${previous.version} had one`)

  return warnings
}

export interface AnalyzeInput {
  spec: Spec
  packument: Packument | undefined
  downloads?: number | undefined
  registry: string
  now?: number | undefined
  minAgeDays?: number | undefined
  // The SPDX ids allowed; a licence outside them, or none, blocks.
  licenses?: string[] | undefined
  // The advisories hitting the resolved version, and the severity at which one blocks.
  advisories?: VersionAdvisory[] | undefined
  // The advisories of the safe version severe enough that a fresh version fixing them is let through, already filtered by the caller.
  safeAdvisories?: VersionAdvisory[] | undefined
  blockSeverity?: Severity | undefined
}

export function analyze(input: AnalyzeInput): Report {
  const { spec, packument, registry, now = Date.now(), minAgeDays = DEFAULT_MIN_AGE_DAYS } = input
  const report: Report = { name: spec.name, registry, exists: packument !== undefined, requested: spec.request, installScripts: {}, nearMisses: nearMisses(spec.name), advisories: input.advisories ?? [], fixes: [], warnings: [], blocked: false, downloads: input.downloads }

  if (report.nearMisses.length > 0)
    report.warnings.push(`name looks like ${report.nearMisses.join('; ')}, check it is the package meant`)

  if (packument === undefined) {
    report.blocked = true
    report.warnings.unshift(`${spec.name} is not on ${registry}, the name may be guessed`)

    return report
  }

  const latest = packument['dist-tags']?.latest
  const version = resolve(packument, spec.request)
  const entry = version === undefined ? undefined : packument.versions?.[version]

  report.description = packument.description
  report.license = licenseOf(entry?.license) ?? licenseOf(packument.license)
  report.repository = repositoryOf(packument)
  report.latest = latest === undefined ? undefined : { version: latest, published: packument.time?.[latest] }
  report.safe = safeRelease(packument, now, minAgeDays)
  report.version = version
  report.published = version === undefined ? undefined : packument.time?.[version]
  report.installScripts = installScriptsOf(entry)
  report.deprecated = entry?.deprecated

  if (version === undefined) {
    report.blocked = true
    report.warnings.push(`no version of ${spec.name} matches ${spec.request}`)

    return report
  }

  const age = ageDays(report.published, now)
  const kept = new Set(report.advisories.map(each => each.id))

  report.fixes = report.safe?.version === version ? [] : (input.safeAdvisories ?? []).filter(each => !kept.has(each.id))

  if (age === undefined) {
    // npmjs.org always dates a version, so a missing date there is a way round the age check
    const isBlocking = minAgeDays > 0 && registry === PUBLIC_HOST

    report.blocked ||= isBlocking
    report.warnings.push(`${registry} gives no publish date for ${version}, its age cannot be checked${isBlocking ? ' and it is refused' : ''}`)
  }
  else if (age < minAgeDays && report.fixes.length > 0) {
    report.warnings.push(`${version} was published ${daysAgo(age)} ago, under ${minAgeDays} days, but it fixes ${report.fixes.map(each => `${each.ghsa ?? each.id} (${each.severity})`).join(', ')} that ${report.safe?.version} has, so its age does not hold it back`)
  }
  else if (age < minAgeDays && registry !== PUBLIC_HOST) {
    // The age check waits out a hijacked release on npmjs.org; a private registry serves the user's own releases, wanted as soon as they are out.
    report.warnings.push(`${version} was published ${daysAgo(age)} ago, under ${minAgeDays} days, not held back on ${registry}`)
  }
  else if (age < minAgeDays) {
    report.blocked = true
    report.warnings.push(`${version} was published ${daysAgo(age)} ago, under ${minAgeDays} days${report.safe === undefined ? ', and no older stable version exists' : `, use ${spec.name}@${report.safe.version}`}`)
  }

  const scripts = Object.keys(report.installScripts)

  if (scripts.length > 0)
    report.warnings.push(`${version} runs ${scripts.join(', ')} at install`)

  if (report.deprecated !== undefined)
    report.warnings.push(`${version} is deprecated: ${report.deprecated}`)

  report.warnings.push(...publisherWarnings(packument, version))

  if (input.licenses !== undefined) {
    const isMissing = report.license === undefined || report.license === ''

    if (isMissing) {
      report.blocked = true
      report.warnings.push(`${version} declares no licence, and the allowlist needs one`)
    }
    else if (!isLicenseAllowed(report.license ?? '', input.licenses)) {
      report.blocked = true
      report.warnings.push(`licence ${report.license} is not in the allowlist (${input.licenses.join(', ')})`)
    }
  }

  if (input.blockSeverity !== undefined) {
    const blocking = filterAdvisories(report.advisories, input.blockSeverity)

    if (blocking.length > 0) {
      report.blocked = true
      report.warnings.push(`${version} has ${blocking.length} advisor${blocking.length === 1 ? 'y' : 'ies'} at ${input.blockSeverity} or above: ${blocking.map(each => each.ghsa ?? each.id).join(', ')}`)
    }
  }

  return report
}
