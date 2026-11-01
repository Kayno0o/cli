import type { Ran } from '@kaynooo/cli-kit'
import type { RegistryConfig } from '../config'
import type { Fetcher } from '../registry'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { duration, fail, formatDuration, note, ok, parse, problem, runCommand, warn } from '@kaynooo/cli-kit'
import { liveRegion } from '@kaynooo/cli-kit/progress'
import { loadConfigs, registryFor } from '../config'
import { addCommand, findConsumers, isLocal } from '../consumers'
import { fetchPackument } from '../registry'

const usage = `pkg bump <name> [version]

Waits until the registry serves the version (the latest when none is given), then runs \`bun add --exact --no-cache\` in each folder under --root whose package.json depends on the package, the kind of dependency kept, a line per folder.
A workspace:, link: or file: dependency, a folder already on the version and one whose lockfile pins another manager are left as they are, each said so.
With --all-consumers each folder whose install went through then runs its own \`check\` (the check bin) and is committed with \`gc 'chore(deps): bump <name> to <version>' -- package.json <lockfile>\` only when that passes; a failing one is left uncommitted and listed in the summary with the skipped ones, and nothing is ever pushed.

Exits 0 when every install ran or was left as it is (with --all-consumers, and every check passed and every commit landed), 1 when an install, a check or a commit fails or the registry has no such package, 2 when the version never shows within the timeout or on a usage error.`

export const ROOT_OPTION = { type: 'string', description: 'the folder holding the repositories (~/Workspace)' } as const

const options = {
  'root': ROOT_OPTION,
  'timeout': { type: 'string', short: 't', description: 'how long to wait for the registry (10m): 30s, 5m, 1h' },
  'all-consumers': { type: 'boolean', description: 'after each install run the folder\'s check and commit it through gc when it passes' },
  'dry-run': { type: 'boolean', description: 'print what would run, changing nothing' },
} as const

const POLL = 5000

export interface BumpSettings {
  root: string
  configs: RegistryConfig[]
  timeout: number
  isDryRun?: boolean
  // Whether each installed folder is checked and committed.
  isAll?: boolean
  fetcher?: Fetcher | undefined
  run?: (argv: string[], cwd: string) => Promise<Ran>
  poll?: number
}

// The version once the registry serves it, the latest when none is asked for; ends the command when it never does.
export async function servedVersion(name: string, version: string | undefined, settings: BumpSettings): Promise<string> {
  const registry = registryFor(name, settings.configs)
  const host = new URL(registry.url).host
  const started = Date.now()
  const region = liveRegion(spinner => [`${spinner} waiting for ${host} to serve ${name}@${version} ${formatDuration(Date.now() - started)}`])

  try {
    for (;;) {
      const packument = await fetchPackument(name, registry, settings.fetcher)
      const latest = packument?.['dist-tags']?.latest

      if (version === undefined && latest !== undefined)
        return latest

      if (version === undefined)
        fail(`${host} has no ${name}`, 1)

      if (packument?.versions?.[version] !== undefined)
        return version

      if (Date.now() - started >= settings.timeout)
        fail(`${host} does not serve ${name}@${version} after ${formatDuration(settings.timeout)}`)

      region.redraw()
      await Bun.sleep(settings.poll ?? POLL)
    }
  }
  finally {
    region.stop()
  }
}

// The lockfile of the folder, which a monorepo keeps at its root, as a path relative to the folder; undefined when there is none.
function lockfileOf(dir: string, root: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    const found = ['bun.lock', 'bun.lockb'].find(file => existsSync(join(at, file)))

    if (found !== undefined)
      return relative(dir, join(at, found))

    if (at === root || at === dirname(at))
      return undefined
  }
}

// Runs a folder's check then commits its bump, returning why it stopped, undefined once committed.
async function checkAndCommit(name: string, version: string, where: string, root: string, run: NonNullable<BumpSettings['run']>): Promise<string | undefined> {
  const checked = await run(['check'], where)

  if (checked.code !== 0)
    return `check exited ${checked.code}: ${checked.text.trim().split('\n').at(-1) ?? ''}`

  const lockfile = lockfileOf(where, root)
  const committed = await run(['gc', `chore(deps): bump ${name} to ${version}`, '--', 'package.json', ...lockfile === undefined ? [] : [lockfile]], where)

  return committed.code === 0 ? undefined : `gc exited ${committed.code}: ${committed.text.trim().split('\n').at(-1) ?? ''}`
}

// Puts the version in every consumer under the root, returning whether every install went through and, with isAll, every check passed and every commit landed.
export async function bumpConsumers(name: string, version: string, settings: BumpSettings): Promise<boolean> {
  const found = findConsumers(name, settings.root)
  const consumers = found.filter(each => !isLocal(each))
  const local = found.length - consumers.length
  const run = settings.run ?? (async (argv, cwd) => runCommand(argv, { cwd }))
  const committed: string[] = []
  const failing: string[] = []
  const skipped: string[] = []
  let isClean = true

  if (found.length === 0)
    note(`nothing under ${settings.root} depends on ${name}`)

  // a monorepo's own packages take it from the workspace, one line saying so for all of them
  if (local > 0)
    note(`${local} workspace:, link: or file: dependenc${local === 1 ? 'y' : 'ies'}`, 'left as they are')

  for (const consumer of consumers) {
    const argv = addCommand(consumer, name, version)
    const where = join(settings.root, consumer.dir)

    if (consumer.spec === version) {
      skipped.push(consumer.dir)
      note(consumer.dir, `already on ${version}`)
    }
    else if (consumer.manager !== 'bun') {
      skipped.push(consumer.dir)
      warn(consumer.dir, `${consumer.spec}, its lockfile pins ${consumer.manager}: put ${version} in by hand`)
    }
    else if (settings.isDryRun === true) {
      note(consumer.dir, `would run ${[argv.join(' '), ...settings.isAll === true ? ['check', `gc 'chore(deps): bump ${name} to ${version}'`] : []].join(', then ')}`)
    }
    else {
      const ran = await run(argv, where)

      if (ran.code !== 0) {
        isClean = false
        failing.push(consumer.dir)
        problem(consumer.dir, `${argv.join(' ')} exited ${ran.code}: ${ran.text.trim().split('\n').at(-1) ?? ''}`)
      }
      else if (settings.isAll !== true) {
        ok(consumer.dir, `${consumer.spec} -> ${version}`)
      }
      else {
        const failure = await checkAndCommit(name, version, where, settings.root, run)

        if (failure === undefined) {
          committed.push(consumer.dir)
          ok(consumer.dir, `${consumer.spec} -> ${version}, checked and committed`)
        }
        else {
          isClean = false
          failing.push(consumer.dir)
          problem(consumer.dir, `${consumer.spec} -> ${version}, left uncommitted: ${failure}`)
        }
      }
    }
  }

  if (settings.isAll === true && settings.isDryRun !== true)
    note('summary', `${committed.length} bumped and committed, ${failing.length} bumped and failing${failing.length > 0 ? ` (${failing.join(', ')})` : ''}, ${skipped.length + local} skipped`)

  return isClean
}

export async function bump(args: string[]): Promise<number> {
  const { values, positionals: [name, asked] } = parse(args, usage, options, { positionals: ['<name>', '[version]'] })
  const settings: BumpSettings = {
    root: values.root ?? join(homedir(), 'Workspace'),
    configs: await loadConfigs(),
    timeout: duration(values.timeout, 'timeout', 10 * 60_000),
    isDryRun: values['dry-run'] === true,
    isAll: values['all-consumers'] === true,
  }
  const version = await servedVersion(name, asked, settings)

  return await bumpConsumers(name, version, settings) ? 0 : 1
}
