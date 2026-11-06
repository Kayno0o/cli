import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { readUserConfig, userConfigPath } from './user-config'

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
  const folder = readUserConfig('config', { home, xdg: env.XDG_CONFIG_HOME }).workspace

  return typeof folder === 'string' && folder !== '' ? folder : undefined
}

// The folder holding the user's repositories: what was given on the command line, else `KAYNOOO_WORKSPACE`, else `workspace` in `~/.config/kaynooo-cli/config.json`, else `~/Workspace`; `~` is expanded in each and the result is absolute.
export function workspaceRoot({ given, env = process.env, home = homedir() }: WorkspaceRootSettings = {}): string {
  const fromEnv = env.KAYNOOO_WORKSPACE === '' ? undefined : env.KAYNOOO_WORKSPACE

  return resolve(expandHome(given ?? fromEnv ?? configured(env, home) ?? join(home, 'Workspace'), home))
}

// Whether the user has chosen a workspace folder, by the variable or by the config file.
export function workspaceChosen({ env = process.env, home = homedir() }: Pick<WorkspaceRootSettings, 'env' | 'home'> = {}): boolean {
  return (env.KAYNOOO_WORKSPACE ?? '') !== '' || configured(env, home) !== undefined
}

// Writes `workspace` into `~/.config/kaynooo-cli/config.json`, keeping every other key; a file that does not parse is left alone and the write refused.
export function saveWorkspace(folder: string, { env = process.env, home = homedir() }: Pick<WorkspaceRootSettings, 'env' | 'home'> = {}): boolean {
  const path = userConfigPath('config', { home, xdg: env.XDG_CONFIG_HOME })
  let current: Record<string, unknown> = {}

  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return false

      current = parsed as Record<string, unknown>
    }
    catch {
      return false
    }
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...current, workspace: folder }, undefined, 2)}\n`)

  return true
}
