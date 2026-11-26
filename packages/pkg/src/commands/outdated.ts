import type { ExitRow, Ran } from '@kaynooo/cli-kit'
import type { Kind } from '../consumers'
import type { Locked } from '../lockfile'
import type { Fetcher } from '../registry'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { capped, fail, formatAge, isInteractive, jsonOption, limitOf, limitOptions, ok, parse, pool, printJson, problem, role, runCommand, table, warn, wholeNumber, writeErr } from '@kaynooo/cli-kit'
import { JS_LOCKFILES } from '@kaynooo/cli-kit/audit'
import { checklist } from '@kaynooo/cli-kit/prompt'
import { advisoriesFor, fetchAdvisories } from '../advisories'
import { analyze, DEFAULT_MIN_AGE_DAYS } from '../analyze'
import { loadConfigs, loadSettings, registryFor } from '../config'
import { addCommand, registryDependencies } from '../consumers'
import { detectManager } from '../manager'
import { fetchPackument } from '../registry'
import { nearestFolder, nearestWith } from '../root'

const usage = `pkg update [dir] [--apply] [--yes] [--major]
pkg outdated [dir]

Lists the dependencies of this folder, or of the nearest folder above with a package.json (and its workspaces) that have a newer version safe to take (at least --min-age days old, or any age for a \`trusted\` name), flagging current versions with known advisories.
With --apply, updates selected packages using the folder's detected package manager (interactive checklist on a TTY unless --yes; skips major bumps unless --major).`

const EXITS: ExitRow[] = [[0, 'listed or updated'], [1, 'an update install failed'], [2, 'the registry could not be reached or answered badly, no package.json, or a usage error']]

const OUTDATED_LIMIT = 50
const BATCH = 8
const FIRST_VERSION = /\d+(?:\.\d+){0,2}(?:-[\w.-]+)?/
const DOT = /[.-]/

const options = {
  'min-age': { type: 'string', description: `days a version must be old (${DEFAULT_MIN_AGE_DAYS}, or the minAge setting)` },
  'apply': { type: 'boolean', description: 'apply the safe updates using the detected package manager' },
  'yes': { type: 'boolean', short: 'y', description: 'with --apply, update every eligible dependency without prompting' },
  'major': { type: 'boolean', description: 'with --apply, include major updates too (default skips major)' },
  'advisories': { type: 'boolean', default: true, description: 'check current versions for known advisories (--no-advisories skips)' },
  ...limitOptions(OUTDATED_LIMIT),
  'json': jsonOption('[{name, workspace?, kind, spec, current, safe, change, published, latest?, advisories?}]'),
} as const

export interface Outdated {
  name: string
  workspace?: string | undefined
  kind: Kind
  spec: string
  current: string
  safe: string
  change: 'major' | 'minor' | 'patch'
  published?: string | undefined
  latest?: string | undefined
  advisories?: number | undefined
}

export interface OutdatedContext {
  dir?: string | undefined
  fetcher?: Fetcher | undefined
  now?: number | undefined
  minAgeDays: number
  concurrency?: number | undefined
  locked: Locked[]
  trusted?: string[] | undefined
  checkAdvisories?: boolean | undefined
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

// The lockfile of the folder or, in a workspace package, the one of the monorepo root above it.
function readLocked(folder: string): Locked[] {
  const at = nearestFolder(folder, each => JS_LOCKFILES.some(spec => existsSync(join(each, spec.file))))
  const spec = at === undefined ? undefined : JS_LOCKFILES.find(each => existsSync(join(at, each.file)))

  return at === undefined || spec === undefined ? [] : spec.parse(readFileSync(join(at, spec.file), 'utf8'))
}

function workspaceDirsOf(folder: string, manifestText: string): string[] {
  try {
    const parsed = JSON.parse(manifestText) as { workspaces?: string[] | { packages?: string[] } }
    const patterns = Array.isArray(parsed.workspaces) ? parsed.workspaces : (parsed.workspaces?.packages ?? [])

    return patterns.flatMap((pattern) => {
      if (!pattern.endsWith('/*')) {
        const dir = join(folder, pattern)

        return existsSync(join(dir, 'package.json')) ? [dir] : []
      }

      const base = join(folder, pattern.slice(0, -2))

      if (!existsSync(base))
        return []

      return readdirSync(base, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
        .map(entry => join(base, entry.name))
    })
  }
  catch {
    return []
  }
}

// The dependencies of a package.json whose safe version is above the one in use, sorted by name.
export async function outdated(manifest: string, context: OutdatedContext): Promise<Outdated[]> {
  const configs = await loadConfigs(context.dir)
  const dependencies = registryDependencies(manifest)
  const looked = await pool(dependencies, context.concurrency ?? BATCH, async ({ name, kind, spec }) => {
    const registry = registryFor(name, configs)
    const packument = await fetchPackument(name, registry, context.fetcher)

    if (packument === undefined) {
      warn(`${name} is not on ${new URL(registry.url).host}`)

      return undefined
    }

    const { safe, latest } = analyze({ spec: { name }, packument, registry: new URL(registry.url).host, now: context.now, minAgeDays: context.minAgeDays, trusted: context.trusted })
    const current = currentOf(name, spec, context.locked)

    if (safe === undefined || current === undefined || Bun.semver.order(safe.version, current) <= 0)
      return undefined

    const row: Outdated = { name, kind, spec, current, safe: safe.version, change: changeOf(current, safe.version), published: safe.published }

    return latest !== undefined && latest.version !== safe.version && Bun.semver.order(latest.version, safe.version) > 0 ? { ...row, latest: latest.version } : row
  })

  const rows = looked.filter((row): row is Outdated => row !== undefined).sort((a, b) => a.name.localeCompare(b.name))

  if (context.checkAdvisories === true && rows.length > 0) {
    const byRegistry = new Map<string, { registry: ReturnType<typeof registryFor>, versions: Record<string, string[]> }>()

    for (const row of rows) {
      const registry = registryFor(row.name, configs)
      const group = byRegistry.get(registry.url) ?? { registry, versions: {} }

      group.versions[row.name] = [...new Set([...group.versions[row.name] ?? [], row.current])]
      byRegistry.set(registry.url, group)
    }

    for (const { registry, versions } of byRegistry.values()) {
      const { found } = await fetchAdvisories(versions, registry, context.fetcher)

      for (const row of rows) {
        const hits = advisoriesFor(found[row.name], row.current)

        if (hits.length > 0)
          row.advisories = hits.length
      }
    }
  }

  return rows
}

export async function outdatedCommand(args: string[], testRun?: (argv: string[], cwd: string) => Promise<Ran>): Promise<number> {
  const { values, positionals: [dir = '.'] } = parse(args, usage, options, { allowNegative: true, positionals: ['[dir]'], exits: EXITS })
  const asked = resolve(dir)
  const folder = nearestWith(asked, 'package.json')

  if (folder === undefined)
    fail(`no package.json in ${asked} or above`)

  if (folder !== asked)
    writeErr(`using the package.json in ${folder}`)

  const rootManifest = await Bun.file(join(folder, 'package.json')).text()
  const locked = readLocked(folder)
  const settings = await loadSettings(folder)
  const minAgeDays = wholeNumber(values['min-age'], 'min-age', settings.minAge ?? DEFAULT_MIN_AGE_DAYS, 0)
  const wsDirs = workspaceDirsOf(folder, rootManifest)
  const allTargets = [{ dir: folder, label: undefined as string | undefined, text: rootManifest }, ...wsDirs.map(ws => ({ dir: ws, label: relative(folder, ws), text: readFileSync(join(ws, 'package.json'), 'utf8') }))]
  const rows: Outdated[] = []

  for (const target of allTargets) {
    const found = await outdated(target.text, {
      dir: folder,
      minAgeDays,
      concurrency: settings.concurrency,
      locked,
      trusted: settings.trusted,
      checkAdvisories: values.advisories !== false,
    })

    for (const row of found)
      rows.push(target.label === undefined ? row : { ...row, workspace: target.label })
  }

  if (values.apply === true) {
    const eligible = rows.filter(row => values.major === true || row.change !== 'major')

    if (eligible.length === 0) {
      if (values.json === true)
        printJson([])
      else
        console.log(role('ok', process.stdout)(rows.length === 0 ? 'nothing outdated' : 'only major updates available (pass --major to include them)'))

      return 0
    }

    let chosen = eligible

    if (values.yes !== true && isInteractive() && values.json !== true) {
      const picked = await checklist(
        'update dependencies',
        eligible.map((row, index) => ({
          value: String(index),
          label: `${row.workspace === undefined ? '' : `[${row.workspace}] `}${row.name}  ${row.current} -> ${row.safe} (${row.change})`,
          hint: row.advisories !== undefined ? `${row.advisories} advisory` : '',
        })),
        { initial: new Set(eligible.map((_, index) => String(index))), hint: 'pass --yes to update all without prompting' },
      )

      if (picked === undefined || picked.size === 0) {
        console.log('nothing updated')

        return 0
      }

      chosen = eligible.filter((_, index) => picked.has(String(index)))
    }

    const detected = detectManager(folder)
    const jsManager = detected === 'pnpm' || detected === 'yarn' || detected === 'npm' ? detected : 'bun'
    const run = testRun ?? (async (argv, cwd) => runCommand(argv, { cwd }))
    let failed = 0

    for (const row of chosen) {
      const where = row.workspace === undefined ? folder : join(folder, row.workspace)
      const argv = addCommand({ dir: row.workspace ?? '.', path: join(where, 'package.json'), kind: row.kind, spec: row.spec, manager: jsManager }, row.name, row.safe)
      const ran = await run(argv, where)

      if (ran.code !== 0) {
        failed++
        problem(row.name, `${argv.join(' ')} exited ${ran.code}`)
      }
      else if (values.json !== true) {
        ok(row.workspace === undefined ? row.name : `${row.workspace}/${row.name}`, `${row.current} -> ${row.safe}`)
      }
    }

    if (values.json === true)
      printJson(chosen)

    return failed > 0 ? 1 : 0
  }

  const { shown, footer } = capped(rows, limitOf(values, OUTDATED_LIMIT))

  if (values.json === true) {
    printJson(shown)
  }
  else if (shown.length === 0) {
    console.log(role('ok', process.stdout)('nothing outdated: every dependency is on its safe version'))
  }
  else {
    const hasWorkspace = shown.some(each => each.workspace !== undefined)
    const headers = [...hasWorkspace ? ['WORKSPACE'] : [], 'PACKAGE', 'KIND', 'CURRENT', 'SAFE', 'CHANGE', 'PUBLISHED', 'LATEST', 'ADVISORIES']

    console.log([
      table([
        headers,
        ...shown.map(each => [
          ...hasWorkspace ? [each.workspace ?? '.'] : [],
          each.name,
          each.kind,
          each.current,
          each.safe,
          each.change,
          each.published === undefined ? '-' : formatAge(each.published),
          each.latest ?? '',
          each.advisories === undefined ? '' : role('problem', process.stdout)(String(each.advisories)),
        ]),
      ], { header: true }),
      ...footer === undefined ? [] : [footer],
    ].join('\n'))
  }

  return 0
}
