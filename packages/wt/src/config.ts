/** Where wt keeps things and how it runs a stack, from `~/.config/wt/config.ts` (`$WT_CONFIG`), every key optional. */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { KnownError } from './errors'

export interface WtConfig {
  /** The folder of `<name>.ts` manifests. */
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

export const configPath = () => process.env.WT_CONFIG ?? join((process.env.XDG_CONFIG_HOME ?? '') || join(homedir(), '.config'), 'wt', 'config.ts')

export function defineConfig(config: WtConfig): WtConfig {
  return config
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

/** The config, read once per process; none at its path means every default. */
export async function wtConfig(): Promise<Resolved> {
  if (loaded)
    return loaded

  const path = configPath()

  if (!existsSync(path))
    return (loaded = resolveConfig())

  try {
    const { default: config } = await import(path) as { default?: WtConfig }

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
