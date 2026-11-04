import type { Options, parse } from '@kaynooo/cli-kit'
import type { ChangelogOptions } from './types'

export const shared = {
  'token': { type: 'string', description: 'Forgejo token, defaults to GITHUB_TOKEN' },
  'from': { type: 'string', description: 'From tag' },
  'to': { type: 'string', description: 'To tag' },
  'repo': { type: 'string', short: 'r', description: 'Forgejo repository, e.g. kaynooo/cli (--gitea is kept as an alias)' },
  'release-repo': { type: 'string', description: 'Release repository, defaults to --repo (--release-gitea is kept as an alias)' },
  'name': { type: 'string', description: 'Name of the release' },
  'contributors': { type: 'boolean', description: 'Show contributors' },
  'prerelease': { type: 'boolean', description: 'Mark release as prerelease' },
  'draft': { type: 'boolean', short: 'd', description: 'Mark release as draft' },
  'output': { type: 'string', description: 'Output to file instead of sending to Forgejo' },
  'capitalize': { type: 'boolean', description: 'Capitalize each commit message' },
  'emoji': { type: 'boolean', description: 'Use emojis in section titles, --no-emoji to drop them' },
  'group': { type: 'boolean', description: 'Nest commit messages under their scopes' },
  'first-parent': { type: 'boolean', description: 'Walk only the first parent of each merge' },
  'discord-webhook': { type: 'string', description: 'Discord webhook to post the release to, defaults to DISCORD_WEBHOOK' },
  'dry-run': { type: 'boolean', description: 'Dry run (--dry is kept as an alias)' },
  'assets': { type: 'string', multiple: true, description: 'Files to upload as assets to the release, repeatable or comma separated; quote globs, e.g. --assets \'dist/*.js\'' },
  'debug': { type: 'boolean', description: 'Print the stack of an unexpected error' },
} as const satisfies Options

export const undoFlags = {
  ...shared,
  note: { type: 'boolean', description: 'Also delete the Forgejo release note (skips the question)' },
  yes: { type: 'boolean', description: 'Skip confirmation prompts' },
} as const satisfies Options

export type Flags = NonNullable<ReturnType<typeof parse<typeof shared>>>['values']

const ALIASES: Record<string, string> = {
  '--dry': '--dry-run',
  '--gitea': '--repo',
  '--release-gitea': '--release-repo',
}

// Rewrites the old flag names to the current ones, up to a bare `--`.
export function aliasFlags(argv: string[]): string[] {
  const end = argv.indexOf('--')
  const head = end === -1 ? argv : argv.slice(0, end)

  return [...head.map((word) => {
    const [name = '', ...value] = word.split('=')
    const current = ALIASES[name]

    return current === undefined ? word : [current, ...value].join('=')
  }), ...end === -1 ? [] : argv.slice(end)]
}

// Keeps only the keys given a value.
function defined<T extends object>(values: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> }
}

// The flags as config options; an absent flag is left out so the config file keeps the say.
export function toOptions(args: Flags): ChangelogOptions {
  return defined({
    token: args.token,
    from: args.from,
    to: args.to,
    repo: args.repo,
    releaseRepo: args['release-repo'],
    name: args.name,
    contributors: args.contributors,
    prerelease: args.prerelease,
    draft: args.draft,
    output: args.output,
    capitalize: args.capitalize,
    emoji: args.emoji,
    group: args.group,
    firstParent: args['first-parent'],
    discordWebhook: args['discord-webhook'],
    dry: args['dry-run'],
    assets: args.assets,
  })
}

// The token goes to the Forgejo host, so only --token and GITHUB_TOKEN (which Forgejo Actions sets) are read, never another service's credentials.
export function withToken(options: ChangelogOptions): ChangelogOptions {
  const token = [options.token, process.env.GITHUB_TOKEN].find(value => value !== undefined && value !== '')

  return token === undefined ? options : { ...options, token }
}

// The release note is only asked about when nothing answers or skips the question.
export function shouldAskNote({ release, note, yes, dry }: { release: unknown, note: boolean | undefined, yes: boolean | undefined, dry: boolean | undefined }): boolean {
  return Boolean(release) && note !== true && yes !== true && dry !== true
}
