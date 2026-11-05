import type { ExitRow } from '@kaynooo/cli-kit'
import type { Kind } from '../consumers'
import type { Locked } from '../lockfile'
import type { Fetcher } from '../registry'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { capped, fail, formatAge, jsonOption, limitOf, limitOptions, parse, pool, printJson, table, warn, wholeNumber } from '@kaynooo/cli-kit'
import { analyze, DEFAULT_MIN_AGE_DAYS } from '../analyze'
import { loadConfigs, loadSettings, registryFor } from '../config'
import { registryDependencies } from '../consumers'
import { parseBunLock } from '../lockfile'
import { fetchPackument } from '../registry'

const usage = `pkg outdated [dir]

Lists the dependencies of the package.json in the folder (the current one by default, registry versions only) that have a newer version safe to take: the highest stable one at least --min-age days old, the \`safe\` of \`pkg check\`. The version in use is the highest one the folder's bun.lock pins that the range allows, else the exact version written, else the first version in the range. A dependency whose newest version is still too fresh shows it under \`latest\`.
It reads only the registry's metadata, no advisories, and changes nothing: \`bun add --exact name@version\` adopts a row.`

const EXITS: ExitRow[] = [[0, 'it listed what is outdated, nothing included'], [2, 'the registry could not be reached or answered badly, no package.json, or a usage error']]

const OUTDATED_LIMIT = 50
const BATCH = 8
const FIRST_VERSION = /\d+(?:\.\d+){0,2}(?:-[\w.-]+)?/
const DOT = /[.-]/

const options = {
  'min-age': { type: 'string', description: `days a version must be old (${DEFAULT_MIN_AGE_DAYS}, or the minAge setting)` },
  ...limitOptions(OUTDATED_LIMIT),
  'json': jsonOption('[{name, kind, spec, current, safe, change, published, latest?}]'),
} as const

export interface Outdated {
  name: string
  kind: Kind
  spec: string
  current: string
  safe: string
  change: 'major' | 'minor' | 'patch'
  published?: string | undefined
  // The newest version when it is not the safe one yet.
  latest?: string | undefined
}

export interface OutdatedContext {
  fetcher?: Fetcher | undefined
  now?: number | undefined
  minAgeDays: number
  // The versions a lockfile pins.
  locked: Locked[]
}

function currentOf(name: string, spec: string, locked: Locked[]): string | undefined {
  const pinned = locked.filter(each => each.name === name && Bun.semver.satisfies(each.version, spec)).map(each => each.version).sort(Bun.semver.order).at(-1)

  const written = FIRST_VERSION.exec(spec)?.[0]

  return pinned ?? (written === undefined ? undefined : [...written.split('.'), '0', '0'].slice(0, 3).join('.'))
}

function changeOf(current: string, next: string): Outdated['change'] {
  const [from, to] = [current, next].map(version => version.split(DOT).map(Number))

  if (from?.[0] !== to?.[0])
    return 'major'

  return from?.[1] === to?.[1] ? 'patch' : 'minor'
}

// The dependencies of a package.json whose safe version is above the one in use, sorted by name.
export async function outdated(manifest: string, context: OutdatedContext): Promise<Outdated[]> {
  const configs = await loadConfigs()
  const dependencies = registryDependencies(manifest)
  const looked = await pool(dependencies, BATCH, async ({ name, kind, spec }) => {
    const registry = registryFor(name, configs)
    const packument = await fetchPackument(name, registry, context.fetcher)

    if (packument === undefined) {
      warn(`${name} is not on ${new URL(registry.url).host}`)

      return undefined
    }

    const { safe, latest } = analyze({ spec: { name }, packument, registry: new URL(registry.url).host, now: context.now, minAgeDays: context.minAgeDays })
    const current = currentOf(name, spec, context.locked)

    if (safe === undefined || current === undefined || Bun.semver.order(safe.version, current) <= 0)
      return undefined

    const row: Outdated = { name, kind, spec, current, safe: safe.version, change: changeOf(current, safe.version), published: safe.published }

    return latest !== undefined && latest.version !== safe.version && Bun.semver.order(latest.version, safe.version) > 0 ? { ...row, latest: latest.version } : row
  })

  return looked.filter(row => row !== undefined).sort((a, b) => a.name.localeCompare(b.name))
}

export async function outdatedCommand(args: string[]): Promise<number> {
  const { values, positionals: [dir = '.'] } = parse(args, usage, options, { positionals: ['[dir]'], exits: EXITS })
  const folder = resolve(dir)
  const manifest = Bun.file(join(folder, 'package.json'))

  if (!await manifest.exists())
    fail(`no package.json in ${folder}`)

  const lockPath = join(folder, 'bun.lock')
  const locked = existsSync(lockPath) ? parseBunLock(await Bun.file(lockPath).text()) : []
  const rows = await outdated(await manifest.text(), { minAgeDays: wholeNumber(values['min-age'], 'min-age', (await loadSettings(folder)).minAge ?? DEFAULT_MIN_AGE_DAYS, 0), locked })
  const { shown, footer } = capped(rows, limitOf(values, OUTDATED_LIMIT))

  if (values.json === true)
    printJson(shown)
  else if (shown.length === 0)
    console.log('nothing outdated: every dependency is on its safe version')
  else
    console.log([table([['PACKAGE', 'KIND', 'CURRENT', 'SAFE', 'CHANGE', 'PUBLISHED', 'LATEST'], ...shown.map(each => [each.name, each.kind, each.current, each.safe, each.change, each.published === undefined ? '-' : formatAge(each.published), each.latest ?? ''])], { header: true }), ...footer === undefined ? [] : [footer]].join('\n'))

  return 0
}
