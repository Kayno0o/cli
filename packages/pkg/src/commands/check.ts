import type { Report } from '../analyze'
import type { RegistryConfig } from '../config'
import type { Fetcher } from '../registry'
import { fail, formatAge, jsonOption, parse, printJson, table, wholeNumber } from '@kaynooo/cli-kit'
import { analyze, DEFAULT_MIN_AGE_DAYS, parseSpec } from '../analyze'
import { loadConfigs, registryFor } from '../config'
import { fetchDownloads, fetchPackument, isPublic } from '../registry'

const usage = `pkg <name>[@version]...

Checks npm packages before they are added: whether the name exists, the latest and the newest version at least two weeks old, weekly downloads, licence, repository, install scripts and a near miss of a popular name.
Exits 1 when a package is missing or the version asked for is under the minimum age.`

const options = {
  'json': jsonOption(),
  'min-age': { type: 'string', description: `days a version must be old (${DEFAULT_MIN_AGE_DAYS})` },
} as const

interface Context {
  configs: RegistryConfig[]
  fetcher?: Fetcher | undefined
  now?: number | undefined
  minAgeDays: number
}

// Looks one package up on the registry its name is installed from, which a scoped .npmrc or bunfig.toml may move off npmjs.org.
export async function checkPackage(text: string, context: Context): Promise<Report> {
  const spec = parseSpec(text)
  const registry = registryFor(spec.name, context.configs)
  const packument = await fetchPackument(spec.name, registry, context.fetcher)
  const downloads = packument !== undefined && isPublic(registry) ? await fetchDownloads(spec.name, context.fetcher) : undefined

  return analyze({ spec, packument, downloads, registry: new URL(registry.url).host, now: context.now, minAgeDays: context.minAgeDays })
}

function when(release: { published?: string | undefined } | undefined, now: number): string {
  return release?.published === undefined ? '' : `, published ${formatAge(release.published, now)} (${release.published.slice(0, 10)})`
}

export function render(report: Report, now = Date.now()): string {
  if (!report.exists)
    return [report.name, ...report.warnings.map(warning => `  warning: ${warning}`)].join('\n')

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
    `${report.name}${report.description === undefined ? '' : `: ${report.description}`}`,
    table(rows.map(([key, value]) => [`  ${key}`, value ?? ''])),
    ...report.warnings.map(warning => `  warning: ${warning}`),
  ].join('\n')
}

export async function check(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values, positionals } = parsed

  if (positionals.length === 0)
    fail(`a package name is needed\n\n${usage}`)

  const context: Context = { configs: await loadConfigs(), minAgeDays: wholeNumber(values['min-age'], 'min-age', DEFAULT_MIN_AGE_DAYS, 0) }
  const reports = await Promise.all(positionals.map(async text => checkPackage(text, context)))

  if (values.json === true)
    printJson(reports.length === 1 ? reports[0] : reports)
  else
    console.log(reports.map(report => render(report)).join('\n\n'))

  return reports.some(report => report.blocked) ? 1 : 0
}
