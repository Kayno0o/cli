import type { ChangelogConfig, GitCommit, RepoConfig } from './changelog'

export type ChangelogenOptions = ChangelogConfig

export interface GiteaRepo {
  owner: string
  repo: string
}

export interface GiteaAuth {
  token: string
  url: string
}

export type Commit = GitCommit

export interface ChangelogOptions extends Partial<ChangelogenOptions> {
  /**
   * Dry run. Skip releasing to Gitea.
   */
  dry?: boolean
  /**
   * Whether to include contributors in release notes.
   *
   * @default true
   */
  contributors?: boolean
  /**
   * Name of the release
   */
  name?: string
  /**
   * Mark the release as a draft
   */
  draft?: boolean
  /**
   * Mark the release as prerelease
   */
  prerelease?: boolean
  /**
   * Gitea Token
   */
  token?: string
  /**
   * Custom titles
   */
  titles?: {
    breakingChanges?: string
    /**
     * Title of the collapsed block holding every type marked `folded`
     */
    maintenance?: string
  }
  /**
   * Capitalize commit messages
   * @default true
   */
  capitalize?: boolean
  /**
   * Nest commit messages under their scopes
   * @default true
   */
  group?: boolean | 'multiple'
  /**
   * Use emojis in section titles
   * @default true
   */
  emoji?: boolean
  /**
   * Gitea base url
   * @default git.kaynooo.fr
   */
  baseUrl?: string
  /**
   * Gitea base API url
   * @default git.kaynooo.fr/api/v1
   */
  baseUrlApi?: string

  /**
   * Walk only the first parent of each merge, so a merged history shows as the merge commit instead of its commits.
   *
   * @default false
   */
  firstParent?: boolean

  /**
   * Filter tags
   */
  tagFilter?: (tag: string) => boolean

  /**
   * Roll up intermediate releases into the range so a minor/major note lists
   * every commit since the previous minor/major, not only since the last patch.
   */
  rollup?: {
    /**
     * On a minor release (`x.y.0`), start the range at the previous minor
     * (`x.(y-1).0`) instead of the last patch, absorbing all patch commits.
     *
     * @default false
     */
    minor?: boolean
    /**
     * On a major release (`x.0.0`), start the range at the previous major
     * (`(x-1).0.0`), absorbing all minor and patch commits.
     *
     * @default false
     */
    major?: boolean
  }

  /**
   * Release repository, defaults to `repo`
   */
  releaseRepo?: RepoConfig | string

  /**
   * Can be set to a custom tag string
   * Any `%s` placeholders in the tag string will be replaced
   * If the tag string does _not_ contain any `%s` placeholders,
   * then the version number will be appended to the tag.
   *
   * @default `v%s`.
   */
  tag?: string

  /**
   * Discord webhook the release is posted to once it is out on Gitea, as an embed
   *
   * @default process.env.DISCORD_WEBHOOK
   */
  discordWebhook?: string

  /**
   * Files to upload as assets to the release
   * `--assets path1,path2` or `--assets path1 --assets path2`
   */
  assets?: string[] | string
}

export type ResolvedChangelogOptions = Required<ChangelogOptions>

export interface AuthorInfo {
  commits: string[]
  login?: string
  avatar?: string
  email: string
  name: string
}
