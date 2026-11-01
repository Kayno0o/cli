import type { Ran } from '@kaynooo/cli-kit'
import type { RegistryConfig } from '../config'
import type { Fetcher } from '../registry'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { duration, fail, formatDuration, note, ok, parse, problem, runCommand, warn } from '@kaynooo/cli-kit'
import { liveRegion } from '@kaynooo/cli-kit/progress'
import { loadConfigs, registryFor } from '../config'
import { addCommand, findConsumers, isLocal } from '../consumers'
import { fetchPackument } from '../registry'

const usage = `pkg bump <name> [version]

Waits until the registry serves the version (the latest when none is given), then runs \`bun add --exact --no-cache\` in each folder under --root whose package.json depends on the package, the kind of dependency kept, a line per folder.
A workspace:, link: or file: dependency, a folder already on the version and one whose lockfile pins another manager are left as they are, each said so.
Exits 1 when an install fails or the version never shows, 2 on a usage error.`

export const ROOT_OPTION = { type: 'string', description: 'the folder holding the repositories (~/Workspace)' } as const

const options = {
  'root': ROOT_OPTION,
  'timeout': { type: 'string', short: 't', description: 'how long to wait for the registry (10m): 30s, 5m, 1h' },
  'dry-run': { type: 'boolean', description: 'print what would run, changing nothing' },
} as const

const POLL = 5000

export interface BumpSettings {
  root: string
  configs: RegistryConfig[]
  timeout: number
  isDryRun?: boolean
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
        fail(`${host} does not serve ${name}@${version} after ${formatDuration(settings.timeout)}`, 1)

      region.redraw()
      await Bun.sleep(settings.poll ?? POLL)
    }
  }
  finally {
    region.stop()
  }
}

// Puts the version in every consumer under the root, returning whether every install went through.
export async function bumpConsumers(name: string, version: string, settings: BumpSettings): Promise<boolean> {
  const found = findConsumers(name, settings.root)
  const consumers = found.filter(each => !isLocal(each))
  const local = found.length - consumers.length
  const run = settings.run ?? (async (argv, cwd) => runCommand(argv, { cwd }))
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
      note(consumer.dir, `already on ${version}`)
    }
    else if (consumer.manager !== 'bun') {
      warn(consumer.dir, `${consumer.spec}, its lockfile pins ${consumer.manager}: put ${version} in by hand`)
    }
    else if (settings.isDryRun === true) {
      note(consumer.dir, `would run ${argv.join(' ')}`)
    }
    else {
      const ran = await run(argv, where)

      if (ran.code === 0) {
        ok(consumer.dir, `${consumer.spec} -> ${version}`)
      }
      else {
        isClean = false
        problem(consumer.dir, `${argv.join(' ')} exited ${ran.code}: ${ran.text.trim().split('\n').at(-1) ?? ''}`)
      }
    }
  }

  return isClean
}

export async function bump(args: string[]): Promise<number> {
  const { values, positionals: [name, asked] } = parse(args, usage, options, { positionals: ['<name>', '[version]'] })
  const settings: BumpSettings = {
    root: values.root ?? join(homedir(), 'Workspace'),
    configs: await loadConfigs(),
    timeout: duration(values.timeout, 'timeout', 10 * 60_000),
    isDryRun: values['dry-run'] === true,
  }
  const version = await servedVersion(name, asked, settings)

  return await bumpConsumers(name, version, settings) ? 0 : 1
}
