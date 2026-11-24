/** Where wt keeps things and how it runs a stack, from `~/.config/kaynooo-cli/config.jsonc#wt` (or `$WT_CONFIG`), every key optional. */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configBase, readUserConfig } from '@kaynooo/cli-kit'
import { KnownError } from './errors'
import { Jobs } from './jobs'

export interface WtConfig {
  /** The folder of `<name>.json` manifests. */
  manifests?: string
  /** The folder a project's worktrees go in, `{root}` standing for its checkout's parent and `{repo}` for the checkout's folder name. */
  worktrees?: string
  /** The folder of the compose overrides wt generates, one per worktree. */
  overrides?: string
  /** Setup markers, clone progress and queues. */
  state?: string
  /** Job files and locks, one set per stack; another tool pointing at the same folder shares a lock per stack with wt. */
  jobs?: string
  /** The network the shared proxy dials the stacks on. */
  proxyNetwork?: string
  /** Argv templates replacing the default stack commands, `{project}`, `{task}`, `{dir}` and `{id}` filled in; `removed` runs after `wt rm`. */
  runner?: { up?: string[], down?: string[], removed?: string[] }
}

export interface Resolved {
  manifests: string
  worktrees: string
  overrides: string
  state: string
  jobs: string
  proxyNetwork: string
  runner: { up?: string[], down?: string[], removed?: string[] }
}

const LEADING_TILDE = /^~(?=\/|$)/

export function expandHome(path: string): string {
  return path.replace(LEADING_TILDE, homedir())
}

export function configPath(): string {
  if (process.env.WT_CONFIG !== undefined && process.env.WT_CONFIG !== '')
    return process.env.WT_CONFIG

  const base = join(configBase(), 'wt')

  for (const name of ['config.jsonc', 'config.json', 'config.ts']) {
    const candidate = join(base, name)

    if (existsSync(candidate))
      return candidate
  }

  return join(base, 'config.json')
}

export function resolveConfig(config: WtConfig = {}): Resolved {
  const configDir = join(configPath(), '..')
  const state = expandHome(config.state ?? join(homedir(), '.cache', 'wt'))

  return {
    manifests: expandHome(config.manifests ?? join(configDir, 'projects')),
    worktrees: expandHome(config.worktrees ?? '{root}/.worktrees/{repo}'),
    overrides: expandHome(config.overrides ?? join(homedir(), '.local', 'share', 'wt', 'overrides')),
    state,
    jobs: expandHome(config.jobs ?? join(state, 'jobs')),
    proxyNetwork: config.proxyNetwork ?? 'proxy',
    runner: config.runner ?? {},
  }
}

let loaded: Resolved | undefined

export function resetWtConfigCache(): void {
  loaded = undefined
}

/** The config, read once per process from config.jsonc#wt or $WT_CONFIG; none means every default. */
export async function wtConfig(): Promise<Resolved> {
  if (loaded)
    return loaded

  const explicit = process.env.WT_CONFIG

  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) {
    try {
      const config = explicit.endsWith('.ts')
        ? ((await import(explicit)) as { default?: WtConfig }).default ?? {}
        : Bun.JSONC.parse(readFileSync(explicit, 'utf8')) as WtConfig

      return (loaded = resolveConfig(config))
    }
    catch (error) {
      throw new KnownError(`${explicit} does not load: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const section = readUserConfig('wt') as WtConfig

  if (Object.keys(section).length > 0)
    return (loaded = resolveConfig(section))

  const path = configPath()

  if (!existsSync(path))
    return (loaded = resolveConfig())

  try {
    const config = path.endsWith('.ts')
      ? ((await import(path)) as { default?: WtConfig }).default ?? {}
      : Bun.JSONC.parse(readFileSync(path, 'utf8')) as WtConfig

    return (loaded = resolveConfig(config))
  }
  catch (error) {
    throw new KnownError(`${path} does not load: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Fills a runner template's placeholders. */
export function fillTemplate(argv: string[], values: Record<string, string>): string[] {
  return argv.map(arg => arg.replaceAll(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match))
}

/** The job records of wt's stacks, in the config's jobs folder. */
export async function wtJobs(): Promise<Jobs> {
  return new Jobs({ dir: (await wtConfig()).jobs, app: 'wt' })
}
