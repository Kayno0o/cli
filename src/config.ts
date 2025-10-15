import type { ChangelogOptions, ResolvedChangelogOptions } from './types'
import { getCurrentGitBranch, getFirstGitCommit, getGiteaRepo, getLastMatchingTag, getSafeTagTemplate, isPrerelease } from './git'

export function defineConfig(config: ChangelogOptions) {
  return config
}

const defaultConfig = {
  scopeMap: {},
  types: {
    feat: { title: '🚀 Features' },
    fix: { title: '🐞 Bug Fixes' },
    perf: { title: '🏎 Performance' },
  },
  titles: {
    breakingChanges: '🚨 Breaking Changes',
  },
  contributors: true,
  capitalize: true,
  group: true,
  tag: 'v%s',
} satisfies ChangelogOptions

export async function resolveConfig(options: ChangelogOptions) {
  const { loadConfig } = await import('c12')
  const config = await loadConfig<ChangelogOptions>({
    name: 'changelogitea',
    defaults: defaultConfig,
    overrides: options,
    packageJson: 'changelogitea',
    // eslint-disable-next-line github/no-then
  }).then(r => r.config || defaultConfig)

  config.baseUrl ??= 'gitea.com'
  config.baseUrlApi ??= 'api.gitea.com'
  config.to ||= await getCurrentGitBranch()
  config.tagFilter ??= () => true
  config.tag = getSafeTagTemplate(config.tag ?? defaultConfig.tag)
  config.from ||= await getLastMatchingTag(
    config.to,
    config.tagFilter,
    config.tag,
  ) || await getFirstGitCommit()
  // @ts-expect-error backward compatibility
  config.repo ||= config.gitea || await getGiteaRepo(config.baseUrl)
  // @ts-expect-error backward compatibility
  config.releaseRepo ||= config.releaseGithub || config.repo
  config.prerelease ??= isPrerelease(config.to)

  if (typeof config.repo !== 'string')
    throw new Error(`Invalid Gitea repository, expected a string but got ${JSON.stringify(config.repo)}`)

  return config as ResolvedChangelogOptions
}
