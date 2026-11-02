import type { Registry } from './registry'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { PUBLIC_REGISTRY, unreachable } from './registry'

// What one .npmrc or bunfig.toml says about registries: a default, one per scope, and tokens by registry address without its protocol.
export interface RegistryConfig {
  registry?: string
  scopes: Record<string, string>
  tokens: Record<string, string>
  scopeTokens: Record<string, string>
}

const ENV_REFERENCE = /\$\{(\w+)\}|\$(\w+)/g
const COMMENT = /^\s*[#;]/
const SCOPE_REGISTRY = /^(@[^:]+):registry$/
const AUTH_TOKEN = /^(\/\/.+?):_authToken$/
const PROTOCOL = /^\w+:/
const TRAILING_SLASHES = /\/+$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const QUOTES = /^(["'])(.*)\1$/

function expand(value: string, env: Record<string, string | undefined>): string | undefined {
  let missing = false
  const expanded = value.replace(ENV_REFERENCE, (_, braced: string | undefined, bare: string | undefined) => {
    const found = env[braced ?? bare ?? '']

    missing ||= found === undefined

    return found ?? ''
  })

  return missing ? undefined : expanded
}

// The value itself, undefined when it refers to an environment variable.
function literal(value: string): string | undefined {
  return expand(value, {}) === value ? value : undefined
}

export function parseNpmrc(text: string, env: Record<string, string | undefined>): RegistryConfig {
  const config: RegistryConfig = { scopes: {}, tokens: {}, scopeTokens: {} }

  for (const line of text.split('\n')) {
    const at = line.indexOf('=')

    if (at === -1 || COMMENT.test(line))
      continue

    const key = line.slice(0, at).trim()
    const scope = SCOPE_REGISTRY.exec(key)?.[1]
    const tokenFor = AUTH_TOKEN.exec(key)?.[1]
    const raw = line.slice(at + 1).trim().replace(QUOTES, '$2')
    // only a token reads the environment: a registry address built from it would let a repo's .npmrc send a variable's value to any host
    const value = tokenFor === undefined ? literal(raw) : expand(raw, env)

    if (value === undefined || value === '')
      continue

    if (scope !== undefined)
      config.scopes[scope] = value
    else if (tokenFor !== undefined)
      config.tokens[tokenFor] = value
    else if (key === 'registry')
      config.registry = value
  }

  return config
}

type BunRegistry = string | { url?: string, token?: string }

function bunEntry(entry: BunRegistry, env: Record<string, string | undefined>): { url?: string, token?: string } {
  const url = typeof entry === 'string' ? entry : entry.url
  const token = typeof entry === 'string' || entry.token === undefined ? undefined : expand(entry.token, env)

  return { ...url === undefined || literal(url) === undefined ? {} : { url }, ...token === undefined ? {} : { token } }
}

export function parseBunfig(text: string, env: Record<string, string | undefined>): RegistryConfig {
  const config: RegistryConfig = { scopes: {}, tokens: {}, scopeTokens: {} }
  const install = (Bun.TOML.parse(text) as { install?: { registry?: BunRegistry, scopes?: Record<string, BunRegistry> } }).install

  if (install?.registry !== undefined) {
    const { url, token } = bunEntry(install.registry, env)

    if (url !== undefined)
      config.registry = url

    if (url !== undefined && token !== undefined)
      config.tokens[url.replace(PROTOCOL, '')] = token
  }

  for (const [scope, entry] of Object.entries(install?.scopes ?? {})) {
    const { url, token } = bunEntry(entry, env)

    if (url !== undefined)
      config.scopes[scope.startsWith('@') ? scope : `@${scope}`] = url

    if (token !== undefined)
      config.scopeTokens[scope.startsWith('@') ? scope : `@${scope}`] = token
  }

  return config
}

// The token of the longest key that prefixes the registry address on a path boundary (`//host` never matches `//host.evil/`), as npm does.
function tokenFor(config: RegistryConfig, url: string): string | undefined {
  const address = `${url.replace(PROTOCOL, '').replace(TRAILING_SLASHES, '')}/`
  const best = Object.keys(config.tokens).filter(key => address.startsWith(`${key.replace(TRAILING_SLASHES, '')}/`)).sort((a, b) => b.length - a.length)[0]

  return best === undefined ? undefined : config.tokens[best]
}

// A token goes over https, or over http to the machine itself, never in clear to another host.
function mayCarryToken(url: string): boolean {
  const { protocol, hostname } = new URL(url)

  return protocol === 'https:' || LOCAL_HOSTS.has(hostname)
}

// The registry a package name is installed from: a scope's own registry wherever a config sets it, else the nearest default, as npm picks it.
export function registryFor(name: string, configs: RegistryConfig[]): Registry {
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined
  const scoped = scope === undefined ? undefined : configs.find(config => config.scopes[scope] !== undefined)
  const url = (scope === undefined ? undefined : scoped?.scopes[scope]) ?? configs.find(config => config.registry !== undefined)?.registry

  if (url === undefined)
    return { url: PUBLIC_REGISTRY }

  const token = (scope === undefined ? undefined : scoped?.scopeTokens[scope]) ?? configs.map(other => tokenFor(other, url)).find(found => found !== undefined)

  return { url, token: mayCarryToken(url) ? token : undefined }
}

// Parses a config file, ending the command on exit 2 ("could not check") when its text is broken.
function readable<T>(path: string, parse: () => T): T {
  try {
    return parse()
  }
  catch (error) {
    return unreachable(`${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readIfThere(path: string): Promise<string | undefined> {
  const file = Bun.file(path)

  return await file.exists() ? file.text() : undefined
}

// Every config from the directory up to the root, then the home directory's, each directory's bunfig.toml before its .npmrc.
export async function loadConfigs(cwd = process.cwd(), env: Record<string, string | undefined> = process.env, home = homedir()): Promise<RegistryConfig[]> {
  const directories: string[] = []

  for (let dir = cwd; !directories.includes(dir); dir = dirname(dir))
    directories.push(dir)

  if (!directories.includes(home))
    directories.push(home)

  const configs: RegistryConfig[] = []

  for (const dir of directories) {
    const bunfig = await readIfThere(join(dir, 'bunfig.toml'))
    const npmrc = await readIfThere(join(dir, '.npmrc'))

    if (bunfig !== undefined)
      configs.push(readable(join(dir, 'bunfig.toml'), () => parseBunfig(bunfig, env)))

    if (npmrc !== undefined)
      configs.push(parseNpmrc(npmrc, env))
  }

  return configs
}

export const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const

export type Severity = typeof SEVERITIES[number]

// The level `pkg check` refuses at when no config sets blockSeverity.
export const DEFAULT_BLOCK_SEVERITY: Severity = 'high'

// What pkg's own config file sets: the SPDX licences allowed, and the advisory severity at which a package is refused.
export interface PkgSettings {
  licenses?: string[] | undefined
  blockSeverity?: Severity | undefined
}

const SETTINGS_FILE = '.pkgrc.json'

export function isSeverity(value: unknown): value is Severity {
  return SEVERITIES.includes(value as Severity)
}

// The settings in one config file's text, a key of the wrong shape left out.
export function parseSettings(text: string): PkgSettings {
  const raw = Bun.JSONC.parse(text) as { licenses?: unknown, blockSeverity?: unknown } | null
  const settings: PkgSettings = {}

  if (Array.isArray(raw?.licenses) && raw.licenses.every(each => typeof each === 'string'))
    settings.licenses = raw.licenses

  if (isSeverity(raw?.blockSeverity))
    settings.blockSeverity = raw.blockSeverity

  return settings
}

// The `.pkgrc.json` files from the directory up to the root, then ~/.config/pkg/config.json, each key taken from the nearest file that sets it.
export async function loadSettings(cwd = process.cwd(), home = homedir()): Promise<PkgSettings> {
  const files: string[] = []

  for (let dir = cwd; !files.includes(join(dir, SETTINGS_FILE)); dir = dirname(dir))
    files.push(join(dir, SETTINGS_FILE))

  files.push(join(home, '.config', 'pkg', 'config.json'))

  const settings: PkgSettings = {}

  for (const file of files) {
    const text = await readIfThere(file)

    if (text === undefined)
      continue

    const found = readable(file, () => parseSettings(text))

    settings.licenses ??= found.licenses
    settings.blockSeverity ??= found.blockSeverity
  }

  return settings
}
