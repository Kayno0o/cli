import { join } from 'node:path'
import process from 'node:process'
import { configBase, configuredForge, fail, readUserConfig, runTool } from '@kaynooo/cli-kit'

export type Provider = 'forgejo' | 'github' | 'gitlab'

export interface ForgeTarget {
  provider: Provider
  host: string
  apiBase: string
  webBase: string
  repo: string
  token?: string | undefined
}

export interface TeaLogin {
  url: string
  sshHost?: string | undefined
  token: string
  isDefault: boolean
}

export interface GlabLogin {
  host: string
  apiHost: string
  protocol: string
  token: string
}

export interface GhLogin {
  host: string
  token: string
}

const PORT = /:\d+$/
const GIT_SUFFIX = /\.git$/i
const TRAILING_SLASHES = /\/+$/
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/
const URL_REMOTE = /^[a-z+]+:\/\/(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\s]+)(?::\d+)?\/(.+)$/i
const REPO_PREFIX = /^(gh|gl|fj|github|gitlab|forgejo):(.+)$/i
const LOGIN_LINE = /^\s*(-\s+)?([a-z_]+):(.*)$/
const QUOTES = /^["']|["']$/g
const CREDENTIALS = /:\/\/[^/@]+@/

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find(value => value !== undefined && value !== '')
}

export function redactUrl(url: string): string {
  return url.replace(CREDENTIALS, '://***@')
}

export function parseRemote(remote: string): { host: string, repo: string } | undefined {
  const text = remote.trim()
  const match = URL_REMOTE.exec(text) ?? SCP_REMOTE.exec(text)

  if (match === null)
    return undefined

  const host = (match[1] ?? '').toLowerCase()
  const repo = (match[2] ?? '').replace(GIT_SUFFIX, '').replace(/^\/+|\/+$/g, '')

  return host !== '' && repo.includes('/') ? { host, repo } : undefined
}

export function originHost(remote: string): string | undefined {
  return parseRemote(remote)?.host
}

export function parseRepoSpec(spec: string): { provider?: Provider, repo: string } {
  const match = REPO_PREFIX.exec(spec.trim())

  if (match === null)
    return { repo: spec.trim() }

  const raw = (match[1] ?? '').toLowerCase()
  let provider: Provider = 'forgejo'

  if (raw === 'gh' || raw === 'github')
    provider = 'github'
  else if (raw === 'gl' || raw === 'gitlab')
    provider = 'gitlab'

  return { provider, repo: (match[2] ?? '').trim() }
}

// The logins of tea's config that carry a token, read line by line: a login starts at a `- ` entry and its keys are indented under it.
export function teaLogins(config: string): TeaLogin[] {
  const logins: TeaLogin[] = []
  let current: Record<string, string> | undefined

  const finish = () => {
    if (current?.url !== undefined && current.token !== undefined && current.token !== '') {
      logins.push({
        url: current.url.replace(TRAILING_SLASHES, ''),
        sshHost: current.ssh_host !== undefined && current.ssh_host !== '' ? current.ssh_host.replace(PORT, '').toLowerCase() : undefined,
        token: current.token,
        isDefault: current.default === 'true',
      })
    }
  }

  for (const line of config.split('\n')) {
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

  return logins
}

const HOST_HEADER = /^(\s*)([a-z0-9.-]+):$/i
const KV_LINE = /^\s*([a-z_]+):(.*)$/i

// Parses host-keyed YAML blocks like `~/.config/glab-cli/config.yml` (under `hosts:`) or `~/.config/gh/hosts.yml`.
function parseHostYaml(config: string, underHostsKey: boolean): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>()
  let inHosts = !underHostsKey
  let hostsIndent = -1
  let currentHost: string | undefined
  let hostIndent = -1

  for (const raw of config.split('\n')) {
    const trimmed = raw.trim()

    if (trimmed === '' || trimmed.startsWith('#'))
      continue

    const indent = raw.length - raw.trimStart().length

    if (underHostsKey && trimmed === 'hosts:') {
      inHosts = true
      hostsIndent = indent
      currentHost = undefined

      continue
    }

    if (!inHosts)
      continue

    if (underHostsKey && indent <= hostsIndent) {
      inHosts = false
      currentHost = undefined

      continue
    }

    const header = HOST_HEADER.exec(raw)

    if (header !== null && (currentHost === undefined || indent <= hostIndent)) {
      currentHost = (header[2] ?? '').toLowerCase()
      hostIndent = indent
      result.set(currentHost, {})

      continue
    }

    if (currentHost !== undefined && indent > hostIndent) {
      const kv = KV_LINE.exec(raw)

      if (kv !== null)
        result.get(currentHost)![kv[1]!.toLowerCase()] = (kv[2] ?? '').trim().replace(QUOTES, '')
    }
  }

  return result
}

export function glabLogins(config: string): GlabLogin[] {
  const logins: GlabLogin[] = []

  for (const [host, fields] of parseHostYaml(config, true)) {
    const token = fields.token ?? ''

    if (token !== '') {
      logins.push({
        host,
        apiHost: (fields.api_host ?? host).replace(PORT, '').toLowerCase(),
        protocol: fields.api_protocol ?? 'https',
        token,
      })
    }
  }

  return logins
}

export function ghLogins(config: string): GhLogin[] {
  const logins: GhLogin[] = []

  for (const [host, fields] of parseHostYaml(config, false)) {
    const token = fields.oauth_token ?? fields.token ?? ''

    if (token !== '')
      logins.push({ host, token })
  }

  return logins
}

async function readText(path: string): Promise<string> {
  try {
    return await Bun.file(path).text()
  }
  catch {
    return ''
  }
}

export async function readTeaConfig(): Promise<string> {
  return readText(join(configBase(), 'tea', 'config.yml'))
}

async function readGlabConfig(): Promise<string> {
  return readText(join(configBase(), 'glab-cli', 'config.yml'))
}

async function readGhConfig(): Promise<string> {
  return readText(join(configBase(), 'gh', 'hosts.yml'))
}

export async function originRemote(): Promise<{ host: string, repo: string } | undefined> {
  const result = await runTool('git remote get-url origin', ['git', 'remote', 'get-url', 'origin'], { timeoutMs: 5000 })

  return result.code === 0 ? parseRemote(result.stdout) : undefined
}

// Resolves SSH alias hostnames from config.jsonc#forgeSsh or ~/.config/tea/config.yml ssh_host entries.
function resolveHostAlias(host: string, teas: TeaLogin[]): string {
  const forgeSsh = readUserConfig('forgeSsh')
  const mapped = forgeSsh[host]

  if (typeof mapped === 'string' && mapped !== '')
    return mapped.toLowerCase()

  const teaBySsh = teas.find(each => each.sshHost === host)

  return teaBySsh !== undefined && URL.canParse(teaBySsh.url) ? new URL(teaBySsh.url).hostname.toLowerCase() : host
}

function hostMatchesTea(host: string, login: TeaLogin): boolean {
  const urlHost = URL.canParse(login.url) ? new URL(login.url).hostname.toLowerCase() : ''

  return urlHost === host || login.sshHost === host
}

function envProvider(): Provider | undefined {
  const raw = process.env.FORGE_PROVIDER?.trim().toLowerCase()

  if (raw === 'forgejo' || raw === 'gitea')
    return 'forgejo'

  if (raw === 'github')
    return 'github'

  return raw === 'gitlab' ? 'gitlab' : undefined
}

async function ghKeyringToken(): Promise<string | undefined> {
  if (Bun.which('gh') === null)
    return undefined

  const ran = await runTool('gh auth token', ['gh', 'auth', 'token'], { timeoutMs: 5000 })

  return ran.code === 0 && ran.stdout.trim() !== '' ? ran.stdout.trim() : undefined
}

function apiBaseFor(provider: Provider, host: string, protocol = 'https'): string {
  if (provider === 'github')
    return host === 'github.com' ? 'https://api.github.com' : `${protocol}://${host}/api/v3`

  return provider === 'gitlab' ? `${protocol}://${host}/api/v4` : `${protocol}://${host}/api/v1`
}

// Resolves forge provider, API base URL, web base URL, repository path, and auth token without spawning tea/glab.
export async function resolveForge(repoArg?: string, providerOverride?: Provider): Promise<ForgeTarget> {
  const parsedSpec = repoArg === undefined ? undefined : parseRepoSpec(repoArg)
  const explicitProvider = providerOverride ?? parsedSpec?.provider ?? envProvider()

  // Direct API override for local HTTP fixtures and custom endpoints.
  const apiOverride = process.env.FORGE_API_URL?.trim()

  if (apiOverride !== undefined && apiOverride !== '') {
    const provider = explicitProvider ?? 'forgejo'
    const base = apiOverride.replace(TRAILING_SLASHES, '')
    const repo = parsedSpec?.repo ?? process.env.FORGE_REPO?.trim() ?? (await originRemote())?.repo ?? 'owner/repo'
    const token = process.env.FORGE_TOKEN ?? process.env.FORGEJO_TOKEN ?? process.env.GITEA_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GITLAB_TOKEN
    const host = URL.canParse(base) ? new URL(base).host : 'localhost'
    const webBase = URL.canParse(base) ? new URL(base).origin : 'https://forge'

    return { provider, host, apiBase: base, webBase, repo, token }
  }

  const [teaRaw, glabRaw, ghRaw, origin] = await Promise.all([readTeaConfig(), readGlabConfig(), readGhConfig(), originRemote()])
  const teas = teaLogins(teaRaw)
  const glabs = glabLogins(glabRaw)
  const ghs = ghLogins(ghRaw)
  const configured = configuredForge()
  const resolvedOriginHost = origin === undefined ? undefined : resolveHostAlias(origin.host, teas)
  const repo = parsedSpec?.repo ?? origin?.repo

  if (repo === undefined || repo === '')
    fail('no repository found: run inside a git repository with an origin remote, or pass -r owner/repo', 2)

  // Determine provider: explicit > origin host match > configured/available logins.
  let provider: Provider | undefined = explicitProvider
  const host = resolvedOriginHost

  if (provider === undefined && host !== undefined) {
    if (host === 'github.com' || ghs.some(each => each.host === host))
      provider = 'github'
    else if (host === 'gitlab.com' || host.startsWith('gitlab.') || glabs.some(each => each.host === host || each.apiHost === host))
      provider = 'gitlab'
    else if (teas.some(each => hostMatchesTea(host, each)) || configured?.host === host)
      provider = 'forgejo'
  }

  if (provider === undefined) {
    if (teas.length > 0 || configured !== undefined)
      provider = 'forgejo'
    else if (ghs.length > 0 || (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '') !== '')
      provider = 'github'
    else if (glabs.length > 0 || (process.env.GITLAB_TOKEN ?? process.env.GL_TOKEN ?? '') !== '')
      provider = 'gitlab'
    else
      provider = 'forgejo'
  }

  if (provider === 'github') {
    const ghHost = host !== undefined && (host === 'github.com' || ghs.some(each => each.host === host)) ? host : (ghs[0]?.host ?? 'github.com')
    const token = firstNonEmpty(process.env.GITHUB_TOKEN, process.env.GH_TOKEN, ghs.find(each => each.host === ghHost)?.token, await ghKeyringToken())

    return {
      provider: 'github',
      host: ghHost,
      apiBase: apiBaseFor('github', ghHost),
      webBase: `https://${ghHost}`,
      repo,
      token,
    }
  }

  if (provider === 'gitlab') {
    const login = (host === undefined ? undefined : glabs.find(each => each.host === host || each.apiHost === host)) ?? glabs[0]
    const glHost = login?.host ?? (host !== undefined && (host === 'gitlab.com' || host.startsWith('gitlab.')) ? host : 'gitlab.com')
    const apiHost = login?.apiHost ?? glHost
    const protocol = login?.protocol ?? 'https'
    const token = firstNonEmpty(process.env.GITLAB_TOKEN, process.env.GL_TOKEN, login?.token)

    return {
      provider: 'gitlab',
      host: glHost,
      apiBase: apiBaseFor('gitlab', apiHost, protocol),
      webBase: `${protocol}://${glHost}`,
      repo,
      token,
    }
  }

  // Forgejo
  const teaMatch = (host === undefined ? undefined : teas.find(each => hostMatchesTea(host, each)))
    ?? teas.find(each => each.isDefault)
    ?? teas[0]
  const rawUrl = firstNonEmpty(process.env.GITEA_CLI_HOST, process.env.FORGEJO_URL, teaMatch?.url, configured?.url, host === undefined ? undefined : `https://${host}`)

  if (rawUrl === undefined)
    fail('no Forgejo host configured: log in with tea or set forge in ~/.config/kaynooo-cli/config.jsonc', 2)

  const parsedUrl = URL.canParse(rawUrl) ? new URL(rawUrl) : new URL(`https://${rawUrl}`)
  const baseOrigin = parsedUrl.origin
  const configToken = readUserConfig('forge').token
  const token = firstNonEmpty(process.env.FORGEJO_TOKEN, process.env.GITEA_TOKEN, teaMatch?.token, typeof configToken === 'string' ? configToken : undefined)

  return {
    provider: 'forgejo',
    host: parsedUrl.hostname.toLowerCase(),
    apiBase: `${baseOrigin}/api/v1`,
    webBase: baseOrigin,
    repo,
    token,
  }
}

export function encodeGitLabProject(repo: string): string {
  return encodeURIComponent(repo)
}
