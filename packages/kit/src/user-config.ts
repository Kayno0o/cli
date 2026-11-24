import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

interface CachedFile {
  mtimeMs: number
  size: number
  data: Record<string, unknown>
}

const FILE_CACHE = new Map<string, CachedFile>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

// The unified config file: prefers `config.jsonc` when present, else `config.json`.
export function mainConfigPath(where: UserConfigLocation = {}): string {
  const jsonc = join(configBase(where), 'kaynooo-cli', 'config.jsonc')

  return existsSync(jsonc) ? jsonc : userConfigPath('config', where)
}

// Where to read a bin's config: the new file, else the first of `legacy` (paths under the config base, such as `['ft', 'config.json']`) that exists, else the new path. A legacy file is never moved or deleted.
export function userConfigReadPath(bin: string, legacy: string[][] = [], where: UserConfigLocation = {}): string {
  if (bin === 'config')
    return mainConfigPath(where)

  const current = userConfigPath(bin, where)

  if (existsSync(current))
    return current

  const base = configBase(where)

  return legacy.map(parts => join(base, ...parts)).find(path => existsSync(path)) ?? current
}

// Reads and caches a JSONC object file by path + mtime/size so repeated lookups stay fast while edits invalidate automatically.
function readCachedObject(path: string): Record<string, unknown> {
  const stat = statSync(path, { throwIfNoEntry: false })

  if (stat === undefined || !stat.isFile()) {
    FILE_CACHE.delete(path)

    return {}
  }

  const cached = FILE_CACHE.get(path)

  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
    return cached.data

  try {
    const parsed: unknown = Bun.JSONC.parse(readFileSync(path, 'utf8'))
    const data = isRecord(parsed) ? parsed : {}

    FILE_CACHE.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, data })

    return data
  }
  catch {
    return {}
  }
}

// The unified main config (`config.jsonc` or `config.json`), cached per process.
export function readMainConfig(where: UserConfigLocation = {}): Record<string, unknown> {
  return readCachedObject(mainConfigPath(where))
}

// The keys of a bin's config (see `userConfigReadPath` for `legacy`), comments allowed; merges any per-bin section inside `config.jsonc`/`config.json` over a legacy per-bin file.
export function readUserConfig(bin: string, where: UserConfigLocation = {}, legacy: string[][] = []): Record<string, unknown> {
  if (bin === 'config')
    return readMainConfig(where)

  const fileData = readCachedObject(userConfigReadPath(bin, legacy, where))
  const section = readMainConfig(where)[bin]

  return isRecord(section) ? { ...fileData, ...section } : fileData
}

// Parses a CLI string value into a boolean, null, finite number, JSON array/object, or plain string.
export function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim()

  if (trimmed === 'true')
    return true

  if (trimmed === 'false')
    return false

  if (trimmed === 'null')
    return null

  if (trimmed !== '' && !Number.isNaN(Number(trimmed)) && Number.isFinite(Number(trimmed)) && String(Number(trimmed)) === trimmed)
    return Number(trimmed)

  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return Bun.JSONC.parse(trimmed)
    }
    catch {}
  }

  return raw
}

function splitKeyPath(keyPath: string): string[] | undefined {
  const parts = keyPath.split('.').filter(Boolean)

  return parts.length === 0 || parts.some(part => FORBIDDEN_KEYS.has(part)) ? undefined : parts
}

export function getConfigKey(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = splitKeyPath(keyPath)

  if (parts === undefined)
    return undefined

  let current: unknown = obj

  for (const part of parts) {
    if (!isRecord(current) || !Object.hasOwn(current, part))
      return undefined

    current = current[part]
  }

  return current
}

export function setConfigKey(obj: Record<string, unknown>, keyPath: string, value: unknown): boolean {
  const parts = splitKeyPath(keyPath)

  if (parts === undefined)
    return false

  let current: Record<string, unknown> = obj

  for (const part of parts.slice(0, -1)) {
    const next = current[part]

    if (!isRecord(next)) {
      const fresh: Record<string, unknown> = {}

      current[part] = fresh
      current = fresh
    }
    else {
      current = next
    }
  }

  current[parts.at(-1)!] = value

  return true
}

export function unsetConfigKey(obj: Record<string, unknown>, keyPath: string): boolean {
  const parts = splitKeyPath(keyPath)

  if (parts === undefined)
    return false

  let current: Record<string, unknown> = obj

  for (const part of parts.slice(0, -1)) {
    const next = current[part]

    if (!isRecord(next))
      return false

    current = next
  }

  const leaf = parts.at(-1)!

  if (!Object.hasOwn(current, leaf))
    return false

  Reflect.deleteProperty(current, leaf)

  return true
}

// Reads the unified main config with JSONC, applies `mutate`, and writes it back; returns false without writing if an existing file does not parse as an object.
export function updateMainConfig(mutate: (config: Record<string, unknown>) => void, where: UserConfigLocation = {}): boolean {
  const path = mainConfigPath(where)
  let current: Record<string, unknown> = {}

  if (existsSync(path)) {
    try {
      const parsed: unknown = Bun.JSONC.parse(readFileSync(path, 'utf8'))

      if (!isRecord(parsed))
        return false

      current = structuredClone(parsed)
    }
    catch {
      return false
    }
  }

  mutate(current)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(current, undefined, 2)}\n`)
  FILE_CACHE.delete(path)

  return true
}

const URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i
const TRAILING_SLASHES = /\/+$/

export interface Forge {
  host: string
  // The forge's web root, https unless the key names its scheme, no trailing slash.
  url: string
}

// The forge `owner/name` shorthands and links point at: the `forge` key of config.json(c), a host or a URL; undefined when unset.
export function configuredForge(where: UserConfigLocation = {}): Forge | undefined {
  const value = readUserConfig('config', where).forge

  if (typeof value !== 'string' || value.trim() === '')
    return undefined

  const url = (URL_SCHEME.test(value.trim()) ? value.trim() : `https://${value.trim()}`).replace(TRAILING_SLASHES, '')

  return URL.canParse(url) ? { host: new URL(url).host, url } : undefined
}

// A positive whole number the bin's config sets under `key`, `fallback` when the key is missing or is anything else.
export function configuredNumber(bin: string, key: string, fallback: number, where: UserConfigLocation = {}, legacy: string[][] = []): number {
  const value = readUserConfig(bin, where, legacy)[key]

  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}
