import type { ExitRow } from '@kaynooo/cli-kit'
import type { AnalyzeInput, Report } from '../analyze'
import type { PkgSettings, RegistryConfig } from '../config'
import type { Fetcher } from '../registry'
import { fail, formatAge, isStdinPiped, jsonOption, parse, printJson, readInput, role, table, wholeNumber } from '@kaynooo/cli-kit'
import { advisoriesFor, fetchAdvisories, filterAdvisories } from '../advisories'
import { analyze, DEFAULT_MIN_AGE_DAYS, parseSpec } from '../analyze'
import { DEFAULT_BLOCK_SEVERITY, loadConfigs, loadSettings, registryFor } from '../config'
import { registryDependencies } from '../consumers'
import { fetchDownloads, fetchPackument, isPublic, unreachable } from '../registry'

const usage = `pkg [check] <name>[@version]... | --from <package.json> | -

Checks npm packages before they are added: whether the name exists, the latest and the newest version at least two weeks old, weekly downloads, licence, repository, install scripts and a near miss of a popular name.

Names come from the arguments, from the dependencies of a package.json with --from (each checked as \`name@range\`, so it resolves what an install would; dev and optional ones included, peer ranges and local or remote sources left out), or from stdin, separated by spaces or lines, when \`-\` is given or nothing else is and stdin is piped.

A \`.pkgrc.json\` (or ~/.config/kaynooo-cli/pkg.json) with \`licenses\` (SPDX ids) refuses a licence outside the list or a missing one, and \`blockSeverity\` (low, moderate, high, critical; high when unset) refuses a version with an advisory at that level or above.`

const EXITS: ExitRow[] = [[0, 'every package passes'], [1, 'one is blocked: missing, the version asked for is under the minimum age or has no date, its licence is outside the allowlist or an advisory reaches the threshold'], [2, 'it could not check (the registry unreachable, slow or answering badly, a broken .pkgrc.json, bunfig.toml or .npmrc) or a usage error']]

const options = {
  'json': jsonOption(),
  'min-age': { type: 'string', description: `days a version must be old (${DEFAULT_MIN_AGE_DAYS}, or the minAge setting)` },
  'from': { type: 'string', description: 'check the dependencies of this package.json' },
} as const

const WORDS = /\s+/

interface Context {
  configs: RegistryConfig[]
  fetcher?: Fetcher | undefined
  now?: number | undefined
  minAgeDays: number
  settings?: PkgSettings | undefined
}

// Looks one package up on the registry its name is installed from, which a scoped .npmrc or bunfig.toml may move off npmjs.org.
export async function checkPackage(text: string, context: Context): Promise<Report> {
  const spec = parseSpec(text)
  const registry = registryFor(spec.name, context.configs)
  const packument = await fetchPackument(spec.name, registry, context.fetcher)
  const downloads = packument !== undefined && isPublic(registry) ? await fetchDownloads(spec.name, context.fetcher) : undefined

  const input: AnalyzeInput = { spec, packument, downloads, registry: new URL(registry.url).host, now: context.now, minAgeDays: context.minAgeDays, licenses: context.settings?.licenses }
  const report = analyze(input)
  const blockSeverity = context.settings?.blockSeverity ?? DEFAULT_BLOCK_SEVERITY

  if (report.version === undefined)
    return report

  // The safe version is asked about too, so a fresh version fixing its advisories is not sent back to it.
  const safe = report.safe?.version
  const { found, unavailable, isUnsupported } = await fetchAdvisories({ [spec.name]: safe === undefined || safe === report.version ? [report.version] : [report.version, safe] }, registry, context.fetcher)

  if (unavailable !== undefined && isUnsupported !== true)
    return unreachable(unavailable)

  const checked = analyze({ ...input, blockSeverity, advisories: advisoriesFor(found[spec.name], report.version), safeAdvisories: safe === undefined ? [] : filterAdvisories(advisoriesFor(found[spec.name], safe), blockSeverity) })

  if (unavailable !== undefined)
    checked.warnings.push(`${unavailable}, so its known advisories are not checked`)

  return checked
}

function when(release: { published?: string | undefined } | undefined, now: number): string {
  return release?.published === undefined ? '' : `, published ${formatAge(release.published, now)} (${release.published.slice(0, 10)})`
}

export function render(report: Report, now = Date.now(), stream: { isTTY?: boolean } = process.stdout): string {
  const id = role('id', stream)
  const warn = role('warn', stream)

  if (!report.exists)
    return [id(report.name), ...report.warnings.map(warning => `  ${warn('warning:')} ${warning}`)].join('\n')

  const asked = report.requested === undefined ? '' : ` (asked for ${report.requested})`
  const rows = [
    ['version', report.version === undefined ? `none${asked}` : `${report.version}${asked}${when(report, now)}`],
    ['latest', report.latest === undefined ? '-' : `${report.latest.version}${when(report.latest, now)}`],
    ['safe', report.safe === undefined ? '-' : `${report.safe.version}${when(report.safe, now)}`],
    ['downloads', report.downloads === undefined ? '-' : `${report.downloads.toLocaleString('en-US')} last week`],
    ['license', report.license ?? '-'],
    ['repository', report.repository ?? '-'],
    ...Object.entries(report.installScripts).map(([name, command]) => [name, command]),
  ]

  return [
    `${id(report.name)}${report.description === undefined ? '' : `: ${report.description}`}`,
    table(rows.map(([key, value]) => [`  ${key}`, value ?? ''])),
    ...report.warnings.map(warning => `  ${warn('warning:')} ${warning}`),
  ].join('\n')
}

// The packages to check: the arguments, the dependencies of --from, and stdin's words when asked for with `-` or when nothing else names a package.
export async function wanted(positionals: string[], from: string | undefined): Promise<string[]> {
  const names = positionals.filter(each => each !== '-')
  const fromFile = from === undefined ? [] : registryDependencies(await readInput(from)).map(({ name, spec }) => `${name}@${spec}`)
  const fromStdin = positionals.includes('-') || (names.length === 0 && fromFile.length === 0 && isStdinPiped()) ? (await readInput('-')).split(WORDS).filter(each => each !== '') : []

  return [...new Set([...names, ...fromFile, ...fromStdin])]
}

export async function check(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { exits: EXITS })

  const { values } = parsed
  const positionals = await wanted(parsed.positionals, values.from)

  if (positionals.length === 0)
    fail(values.from === undefined ? `a package name is needed\n\n${usage}` : `${values.from} has no registry dependency to check`)

  const settings = await loadSettings()
  const context: Context = { configs: await loadConfigs(), settings, minAgeDays: wholeNumber(values['min-age'], 'min-age', settings.minAge ?? DEFAULT_MIN_AGE_DAYS, 0) }
  const reports = await Promise.all(positionals.map(async text => checkPackage(text, context)))

  if (values.json === true)
    printJson(reports.length === 1 ? reports[0] : reports)
  else
    console.log(reports.map(report => render(report)).join('\n\n'))

  return reports.some(report => report.blocked) ? 1 : 0
}
