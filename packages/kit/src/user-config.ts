import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export interface UserConfigLocation {
  // The home folder; `$XDG_CONFIG_HOME` is then ignored unless `xdg` is given too.
  home?: string | undefined
  // The config base folder, `$XDG_CONFIG_HOME` or `<home>/.config` by default.
  xdg?: string | undefined
}

export function configBase(where: UserConfigLocation = {}): string {
  const xdg = where.xdg ?? (where.home === undefined ? process.env.XDG_CONFIG_HOME : undefined)

  return xdg !== undefined && xdg !== '' ? xdg : join(where.home ?? homedir(), '.config')
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
