import type { ChangelogOptions, ResolvedChangelogOptions } from './types'
import { join } from 'node:path'
import { getCurrentGitBranch, getFirstGitCommit, getGiteaRepo, getLastMatchingTag, getSafeTagTemplate, isPrerelease } from './git'

export function defineConfig(config: ChangelogOptions) {
  return config
}

const configFiles = ['ts', 'mts', 'js', 'mjs', 'json'].map(ext => `changelogitea.config.${ext}`)

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
      return (await import(path)).default ?? {}
  }

  return {}
}

async function loadPackageConfig(cwd: string): Promise<ChangelogOptions> {
  const file = Bun.file(join(cwd, 'package.json'))

  if (!await file.exists())
    return {}

  return (await file.json()).changelogitea ?? {}
}

// Layers, lowest first: defaults, the package.json `changelogitea` field, `changelogitea.config.*`, then the options passed in.
export async function loadConfig(options: ChangelogOptions, cwd = process.cwd()): Promise<ChangelogOptions> {
  const [packageConfig, fileConfig] = await Promise.all([loadPackageConfig(cwd), loadConfigFile(cwd)])

  return mergeLayers(defaultConfig, packageConfig, fileConfig, options) as ChangelogOptions
}

export async function resolveConfig(options: ChangelogOptions) {
  const config = await loadConfig(options)

  config.baseUrl ??= 'git.kaynooo.fr'
  config.baseUrlApi ??= config.baseUrl ? `${config.baseUrl}/api/v1` : 'git.kaynooo.fr/api/v1'
  config.to ||= await getCurrentGitBranch()
  config.tagFilter ??= () => true
  config.tag = getSafeTagTemplate(config.tag ?? defaultConfig.tag)
  config.rollup ??= {}
  config.from ||= await getLastMatchingTag(
    config.to,
    config.tagFilter,
    config.tag,
    config.rollup,
    config.firstParent,
  ) || await getFirstGitCommit(config.firstParent)
  // @ts-expect-error backward compatibility
  config.repo ||= config.gitea || await getGiteaRepo()
  // @ts-expect-error backward compatibility
  config.releaseRepo ||= config.releaseGithub || config.repo
  config.prerelease ??= isPrerelease(config.to)
  config.discordWebhook ??= process.env.DISCORD_WEBHOOK || ''

  if (typeof config.repo !== 'string')
    throw new Error(`Invalid Gitea repository, expected a string but got ${JSON.stringify(config.repo)}`)

  return config as ResolvedChangelogOptions
}
