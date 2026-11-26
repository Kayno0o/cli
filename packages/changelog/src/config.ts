import type { ChangelogOptions, ResolvedChangelogOptions } from './types'
import { join } from 'node:path'
import process from 'node:process'
import { configBase, configuredForge } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { getCurrentGitBranch, getFirstGitCommit, getGiteaRepo, getLastMatchingTag, getOriginHost, getSafeTagTemplate, isPrerelease } from './git'

const GITHUB = 'github.com'
const GITLAB = 'gitlab.com'
const QUOTES = /^["']|["']$/g
const LOGIN_LINE = /^\s*(-\s+)?([a-z_]+):(.*)$/
const HOST_HEADER = /^(\s*)([a-z0-9.-]+):$/i
const KV_LINE = /^\s*([a-z_]+):(.*)$/i

export function defineConfig(config: ChangelogOptions) {
  return config
}

// The forge's name in messages.
export function forgeName(config: ChangelogOptions): string {
  if (config.provider === 'github')
    return 'GitHub'

  return config.provider === 'gitlab' ? 'GitLab' : 'Forgejo'
}

async function readText(path: string): Promise<string> {
  try {
    return await Bun.file(path).text()
  }
  catch {
    return ''
  }
}

// The first host a tea login answers to by URL or SSH host wins, then the default login.
async function teaTokenFor(hosts: (string | undefined)[]): Promise<string | undefined> {
  const raw = await readText(join(configBase(), 'tea', 'config.yml'))
  let current: Record<string, string> | undefined
  const logins: { url: string, sshHost?: string | undefined, token: string, isDefault: boolean }[] = []

  const finish = () => {
    if (current?.url !== undefined && current.token !== undefined && current.token !== '')
      logins.push({ url: current.url, sshHost: current.ssh_host, token: current.token, isDefault: current.default === 'true' })
  }

  for (const line of raw.split('\n')) {
    const entry = LOGIN_LINE.exec(line)

    if (entry === null)
      continue

    if (entry[1] !== undefined) {
      finish()
      current = {}
    }

    if (current !== undefined)
      current[entry[2]!] = (entry[3] ?? '').trim().replace(QUOTES, '')
  }

  finish()

  const matches = (host: string) => logins.find(each => (URL.canParse(each.url) && new URL(each.url).hostname.toLowerCase() === host) || each.sshHost?.toLowerCase() === host)
  const match = hosts.map(host => host === undefined ? undefined : matches(host.toLowerCase())).find(Boolean)

  return (match ?? logins.find(each => each.isDefault))?.token
}

async function hostYamlToken(path: string, underHosts: boolean, host: string, key: 'token' | 'oauth_token'): Promise<string | undefined> {
  const raw = await readText(path)
  let inHosts = !underHosts
  let hostsIndent = -1
  let currentHost: string | undefined
  let hostIndent = -1
  const map = new Map<string, Record<string, string>>()

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()

    if (trimmed === '' || trimmed.startsWith('#'))
      continue

    const indent = line.length - line.trimStart().length

    if (underHosts && trimmed === 'hosts:') {
      inHosts = true
      hostsIndent = indent
      currentHost = undefined

      continue
    }

    if (!inHosts)
      continue

    if (underHosts && indent <= hostsIndent) {
      inHosts = false
      currentHost = undefined

      continue
    }

    const header = HOST_HEADER.exec(line)

    if (header !== null && (currentHost === undefined || indent <= hostIndent)) {
      currentHost = (header[2] ?? '').toLowerCase()
      hostIndent = indent
      map.set(currentHost, {})

      continue
    }

    if (currentHost !== undefined && indent > hostIndent) {
      const kv = KV_LINE.exec(line)

      if (kv !== null)
        map.get(currentHost)![kv[1]!.toLowerCase()] = (kv[2] ?? '').trim().replace(QUOTES, '')
    }
  }

  const fields = map.get(host.toLowerCase())

  return firstNonEmpty(fields?.[key], fields?.token)
}

const configFiles = ['ts', 'mts', 'js', 'mjs', 'json'].map(ext => `changelog.config.${ext}`)

const defaultConfig = {
  scopeMap: {},
  types: {
    feat: { title: '✨ New' },
    fix: { title: '🔧 Fixed' },
    perf: { title: '⚡ Faster' },
    refactor: { title: 'refactor', folded: true },
    docs: { title: 'docs', folded: true },
    build: { title: 'build', folded: true },
    types: { title: 'types', folded: true },
    test: { title: 'test', folded: true },
    style: { title: 'style', folded: true },
    ci: { title: 'ci', folded: true },
  },
  titles: {
    breakingChanges: '⚠️ Breaking',
    highlights: '🌟 Highlights',
    maintenance: '🧹 Maintenance',
  },
  contributors: true,
  capitalize: true,
  group: true,
  emoji: true,
  firstParent: false,
  tag: 'v%s',
} satisfies ChangelogOptions

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Later layers win; plain objects merge key by key, anything else (arrays, functions) is replaced, and an undefined value never overrides.
function mergeLayers(...layers: object[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}

  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined)
        continue

      merged[key] = isPlainObject(value) && isPlainObject(merged[key]) ? mergeLayers(merged[key], value) : value
    }
  }

  return merged
}

async function loadConfigFile(cwd: string): Promise<ChangelogOptions> {
  for (const name of configFiles) {
    const path = join(cwd, name)

    if (await Bun.file(path).exists())
      return (await import(path) as { default?: ChangelogOptions }).default ?? {}
  }

  return {}
}

// gh's own login, for a GitHub release given no token; undefined without gh or a login.
async function ghToken(): Promise<string | undefined> {
  if (Bun.which('gh') === null)
    return undefined

  const answer = await $`gh auth token`.quiet().nothrow()

  return answer.exitCode === 0 && answer.text().trim() !== '' ? answer.text().trim() : undefined
}

async function loadPackageConfig(cwd: string): Promise<ChangelogOptions> {
  const file = Bun.file(join(cwd, 'package.json'))

  return !await file.exists() ? {} : (await file.json() as { changelog?: ChangelogOptions }).changelog ?? {}
}

// Layers, lowest first: defaults, the package.json `changelog` field, `changelog.config.*`, then the options passed in.
export async function loadConfig(options: ChangelogOptions, cwd = process.cwd()): Promise<ChangelogOptions> {
  const [packageConfig, fileConfig] = await Promise.all([loadPackageConfig(cwd), loadConfigFile(cwd)])

  return mergeLayers(defaultConfig, packageConfig, fileConfig, options)
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find(value => value !== undefined && value !== '')
}

function defaultProvider(baseUrl: string): 'github' | 'gitlab' | 'gitea' {
  if (baseUrl === GITHUB)
    return 'github'

  return baseUrl === GITLAB || baseUrl.startsWith('gitlab.') ? 'gitlab' : 'gitea'
}

function defaultApiUrl(provider: 'github' | 'gitlab' | 'gitea', baseUrl: string): string {
  if (provider === 'github')
    return 'api.github.com'

  return provider === 'gitlab' ? `${baseUrl}/api/v4` : `${baseUrl}/api/v1`
}

export async function resolveConfig(options: ChangelogOptions) {
  const config = await loadConfig(options)

  // origin may be the forge's private address, while the links want the public one config.json names.
  const origin = config.baseUrl === undefined ? await getOriginHost() : undefined

  const isGitlabHost = origin === GITLAB || (origin?.startsWith('gitlab.') ?? false)
  const baseUrl = config.baseUrl ?? (origin === GITHUB || isGitlabHost ? origin : configuredForge()?.host ?? origin)

  if (baseUrl === undefined || baseUrl === '')
    throw new Error('no forge to link the notes to: set baseUrl in the changelog config, forge in ~/.config/kaynooo-cli/config.json, or an origin remote')

  config.baseUrl = baseUrl
  config.provider ??= defaultProvider(baseUrl)
  config.baseUrlApi ??= defaultApiUrl(config.provider, baseUrl)

  if ((config.token ?? '') === '') {
    let token: string | undefined

    if (config.provider === 'github')
      token = firstNonEmpty(process.env.GH_TOKEN, await hostYamlToken(join(configBase(), 'gh', 'hosts.yml'), false, baseUrl, 'oauth_token'), await ghToken())
    else if (config.provider === 'gitlab')
      token = firstNonEmpty(process.env.GITLAB_TOKEN, process.env.GL_TOKEN, await hostYamlToken(join(configBase(), 'glab-cli', 'config.yml'), true, baseUrl, 'token'))
    else
      // A forge named by its public address keeps the tea login of the private one origin uses.
      token = firstNonEmpty(process.env.FORGEJO_TOKEN, process.env.GITEA_TOKEN, await teaTokenFor([baseUrl, origin]))

    if (token !== undefined)
      config.token = token
  }

  config.to ||= await getCurrentGitBranch()
  config.tagFilter ??= () => true
  config.tag = getSafeTagTemplate(config.tag ?? defaultConfig.tag)
  config.rollup ??= {}
  // Worked out here alone, so a config file setting it never drops a given from.
  config.fromRoot = false

  if (config.from === undefined || config.from === '') {
    const tag = await getLastMatchingTag(config.to, config.tagFilter, config.tag, config.rollup, config.firstParent)

    config.fromRoot = tag === undefined
    config.from = tag ?? await getFirstGitCommit(config.firstParent, config.to)
  }

  // The option names it had before Forgejo, still read from older configs.
  const legacy = config as ChangelogOptions & { gitea?: string, releaseGithub?: string }

  config.repo ||= legacy.gitea ?? await getGiteaRepo()
  config.releaseRepo ||= legacy.releaseGithub ?? config.repo
  config.prerelease ??= isPrerelease(config.to)
  config.discordWebhook ??= process.env.DISCORD_WEBHOOK ?? ''

  if (typeof config.repo !== 'string')
    throw new TypeError(`Invalid repository, expected a string but got ${JSON.stringify(config.repo)}`)

  return config as ResolvedChangelogOptions
}
