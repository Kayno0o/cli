import type { Registry } from './registry'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { PUBLIC_REGISTRY } from './registry'

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

export function parseNpmrc(text: string, env: Record<string, string | undefined>): RegistryConfig {
  const config: RegistryConfig = { scopes: {}, tokens: {}, scopeTokens: {} }

  for (const line of text.split('\n')) {
    const at = line.indexOf('=')

    if (at === -1 || COMMENT.test(line))
      continue

    const key = line.slice(0, at).trim()
    const value = expand(line.slice(at + 1).trim().replace(QUOTES, '$2'), env)

    if (value === undefined || value === '')
      continue

    const scope = SCOPE_REGISTRY.exec(key)?.[1]
    const tokenFor = AUTH_TOKEN.exec(key)?.[1]

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

  return { ...url === undefined ? {} : { url: expand(url, env) ?? url }, ...token === undefined ? {} : { token } }
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

// The token of the longest key that prefixes the registry address, as npm does.
function tokenFor(config: RegistryConfig, url: string): string | undefined {
  const address = url.replace(PROTOCOL, '')
  const best = Object.keys(config.tokens).filter(key => address.startsWith(key)).sort((a, b) => b.length - a.length)[0]

  return best === undefined ? undefined : config.tokens[best]
}

// The registry a package name is installed from: a scope's own registry, else the default, the nearest config winning.
export function registryFor(name: string, configs: RegistryConfig[]): Registry {
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined

  for (const config of configs) {
    const url = scope === undefined ? config.registry : config.scopes[scope] ?? config.registry

    if (url === undefined)
      continue

    const token = (scope === undefined ? undefined : config.scopeTokens[scope]) ?? tokenFor(config, url) ?? configs.map(other => tokenFor(other, url)).find(found => found !== undefined)

    return { url, token }
  }

  return { url: PUBLIC_REGISTRY }
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
      configs.push(parseBunfig(bunfig, env))

    if (npmrc !== undefined)
      configs.push(parseNpmrc(npmrc, env))
  }

  return configs
}
