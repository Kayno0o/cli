import type { ChangelogOptions, ResolvedChangelogOptions } from './types'
import { join } from 'node:path'
import { configuredForge } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { getCurrentGitBranch, getFirstGitCommit, getGiteaRepo, getLastMatchingTag, getOriginHost, getSafeTagTemplate, isPrerelease } from './git'

const GITHUB = 'github.com'

export function defineConfig(config: ChangelogOptions) {
  return config
}

// The forge's name in messages.
export function forgeName(config: ChangelogOptions): string {
  return config.provider === 'github' ? 'GitHub' : 'Forgejo'
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

export async function resolveConfig(options: ChangelogOptions) {
  const config = await loadConfig(options)

  // origin may be the forge's private address, while the links want the public one config.json names.
  const origin = config.baseUrl === undefined ? await getOriginHost() : undefined

  const baseUrl = config.baseUrl ?? (origin === GITHUB ? origin : configuredForge()?.host ?? origin)

  if (baseUrl === undefined || baseUrl === '')
    throw new Error('no forge to link the notes to: set baseUrl in the changelog config, forge in ~/.config/kaynooo-cli/config.json, or an origin remote')

  config.baseUrl = baseUrl
  config.provider ??= baseUrl === GITHUB ? 'github' : 'gitea'
  config.baseUrlApi ??= config.provider === 'github' ? 'api.github.com' : `${baseUrl}/api/v1`

  const token = config.provider === 'github' && (config.token ?? '') === '' ? await ghToken() : undefined

  if (token !== undefined)
    config.token = token

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
