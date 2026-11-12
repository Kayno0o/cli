import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'

// An XDG base folder variable's value, or the fallback when it is unset, empty or relative, as the spec says to ignore those.
export function xdgFolder(value: string | undefined, fallback: string): string {
  return value !== undefined && isAbsolute(value) ? value : fallback
}

export interface UserConfigLocation {
  // The home folder; `$XDG_CONFIG_HOME` is then ignored unless `xdg` is given too.
  home?: string | undefined
  // The config base folder, `$XDG_CONFIG_HOME` or `<home>/.config` by default.
  xdg?: string | undefined
}

export function configBase(where: UserConfigLocation = {}): string {
  const xdg = where.xdg ?? (where.home === undefined ? process.env.XDG_CONFIG_HOME : undefined)

  return xdgFolder(xdg, join(where.home ?? homedir(), '.config'))
}

// The one config file of a bin, `~/.config/kaynooo-cli/<bin>.json`: where it is written.
export function userConfigPath(bin: string, where: UserConfigLocation = {}): string {
  return join(configBase(where), 'kaynooo-cli', `${bin}.json`)
}

// Where to read a bin's config: the new file, else the first of `legacy` (paths under the config base, such as `['ft', 'config.json']`) that exists, else the new path. A legacy file is never moved or deleted.
export function userConfigReadPath(bin: string, legacy: string[][] = [], where: UserConfigLocation = {}): string {
  const current = userConfigPath(bin, where)

  if (existsSync(current))
    return current

  const base = configBase(where)

  return legacy.map(parts => join(base, ...parts)).find(path => existsSync(path)) ?? current
}

// The keys of a bin's config file (see `userConfigReadPath` for `legacy`), comments allowed; empty when the file is missing, does not parse or is no object.
export function readUserConfig(bin: string, where: UserConfigLocation = {}, legacy: string[][] = []): Record<string, unknown> {
  const path = userConfigReadPath(bin, legacy, where)

  if (!existsSync(path))
    return {}

  try {
    const parsed: unknown = Bun.JSONC.parse(readFileSync(path, 'utf8'))

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

// A positive whole number the bin's config file sets under `key`, `fallback` when the key is missing or is anything else.
export function configuredNumber(bin: string, key: string, fallback: number, where: UserConfigLocation = {}, legacy: string[][] = []): number {
  const value = readUserConfig(bin, where, legacy)[key]

  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}
