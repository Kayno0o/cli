import type { UserConfigLocation } from './user-config'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { readUserConfig, xdgFolder } from './user-config'

/** Folders a walk over a repository's packages never descends into: dependencies and build output. A bin adds its own to a copy. */
export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', 'venv', '__pycache__'])

/** `SKIPPED_FOLDERS` plus the names in the `ignore` key of `~/.config/kaynooo-cli/config.json` and the `extra` ones a bin adds, for the walks of `check`, `code`, `docker`, `env` and `pkg consumers`. */
export function ignoredFolders(extra: Iterable<string> = [], where: UserConfigLocation = {}): Set<string> {
  const configured = readUserConfig('config', where).ignore
  const names = Array.isArray(configured) ? configured.filter((name): name is string => typeof name === 'string' && name !== '') : []

  return new Set([...SKIPPED_FOLDERS, ...extra, ...names])
}

/** The user's cache folder, `$XDG_CACHE_HOME` when absolute or `~/.cache`, where the bins keep what they can rebuild: histories, answers, completions. */
export function cacheFolder({ home = homedir(), env = process.env }: { home?: string, env?: Record<string, string | undefined> } = {}): string {
  return xdgFolder(env.XDG_CACHE_HOME, join(home, '.cache'))
}
