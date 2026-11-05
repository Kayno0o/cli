import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { userConfigPath } from './user-config'

export interface WorkspaceRootSettings {
  // The root a `--root` flag or a positional gave, which wins over everything.
  given?: string | undefined
  env?: Record<string, string | undefined>
  home?: string
}

// `~` and `~/x` as the home folder and a path under it.
function expandHome(path: string, home: string): string {
  if (path === '~')
    return home

  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

// The `workspace` key of `~/.config/kaynooo-cli/config.json`, undefined when the file or the key is missing or the file does not parse.
function configured(env: Record<string, string | undefined>, home: string): string | undefined {
  const path = userConfigPath('config', { home, xdg: env.XDG_CONFIG_HOME })

  if (!existsSync(path))
    return undefined

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const folder = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).workspace : undefined

    return typeof folder === 'string' && folder !== '' ? folder : undefined
  }
  catch {
    return undefined
  }
}

// The folder holding the user's repositories: what was given on the command line, else `KAYNOOO_WORKSPACE`, else `workspace` in `~/.config/kaynooo-cli/config.json`, else `~/Workspace`; `~` is expanded in each and the result is absolute.
export function workspaceRoot({ given, env = process.env, home = homedir() }: WorkspaceRootSettings = {}): string {
  const fromEnv = env.KAYNOOO_WORKSPACE === '' ? undefined : env.KAYNOOO_WORKSPACE

  return resolve(expandHome(given ?? fromEnv ?? configured(env, home) ?? join(home, 'Workspace'), home))
}
