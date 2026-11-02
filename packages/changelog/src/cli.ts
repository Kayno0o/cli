#!/usr/bin/env bun

import type { Options } from '@kaynooo/cli-kit'
import type { ChangelogOptions, ResolvedChangelogOptions } from './types'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, runCli } from '@kaynooo/cli-kit'
import { confirm } from '@kaynooo/cli-kit/prompt'
import { sendDiscordWebhook } from '@kaynooo/utils'
import { colors } from '@kaynooo/utils/tools/colors'
import { $ } from 'bun'
import { version } from '../package.json'
import { deleteRelease, deleteRemoteTag, getRelease, hasRemoteTag, uploadAssets } from './gitea'
import { deleteLocalTag, deleteRemoteGitTag, generate, getCommitSubject, getGiteaRepo, getGitTags, getHeadCommit, getTagCommit, hasRemoteGitTag, hasTagOnGitea, isRefGitTag, isRepoShallow, resolveConfig, sendRelease, softResetLastCommit } from './index'

const shared = {
  'token': { type: 'string', short: 't', description: 'Gitea token' },
  'from': { type: 'string', description: 'From tag' },
  'to': { type: 'string', description: 'To tag' },
  'gitea': { type: 'string', description: 'Gitea repository, e.g. kaynooo/changelogitea' },
  'release-gitea': { type: 'string', description: 'Release Gitea repository, defaults to --gitea' },
  'name': { type: 'string', description: 'Name of the release' },
  'contributors': { type: 'boolean', description: 'Show contributors' },
  'prerelease': { type: 'boolean', description: 'Mark release as prerelease' },
  'draft': { type: 'boolean', short: 'd', description: 'Mark release as draft' },
  'output': { type: 'string', description: 'Output to file instead of sending to Gitea' },
  'capitalize': { type: 'boolean', description: 'Capitalize each commit message' },
  'emoji': { type: 'boolean', description: 'Use emojis in section titles, --no-emoji to drop them' },
  'group': { type: 'boolean', description: 'Nest commit messages under their scopes' },
  'first-parent': { type: 'boolean', description: 'Walk only the first parent of each merge' },
  'discord-webhook': { type: 'string', description: 'Discord webhook to post the release to, defaults to DISCORD_WEBHOOK' },
  'dry': { type: 'boolean', description: 'Dry run' },
  'assets': { type: 'string', multiple: true, description: 'Files to upload as assets to the release, repeatable or comma separated; quote globs, e.g. --assets \'dist/*.js\'' },
} as const satisfies Options

const undoFlags = {
  ...shared,
  note: { type: 'boolean', description: 'Also delete the Gitea release note (skips the question)' },
  yes: { type: 'boolean', description: 'Skip confirmation prompts' },
} as const satisfies Options

type Flags = NonNullable<ReturnType<typeof parse<typeof shared>>>['values']

// Keeps only the keys given a value.
function defined<T extends object>(values: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> }
}

// The flags as config options; an absent flag is left out so the config file keeps the say.
function toOptions(args: Flags): ChangelogOptions {
  return defined({
    token: args.token,
    from: args.from,
    to: args.to,
    repo: args.gitea,
    releaseRepo: args['release-gitea'],
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
    dry: args.dry,
    assets: args.assets,
  })
}

async function ask(question: string) {
  return await confirm(question, { default: false, hint: 'pass --yes to skip the questions' }) === true
}

async function readTokenFromGiteaCli() {
  try {
    return (await $`gh auth token`.quiet().text()).trim()
  }
  catch {
    return ''
  }
}

async function withToken(options: ChangelogOptions) {
  const token = [options.token, process.env.GITHUB_TOKEN].find(value => value !== undefined && value !== '') ?? await readTokenFromGiteaCli()

  return token !== '' ? { ...options, token } : options
}

// Forgejo's new-release page only reads `tag`, so the notes go to a file to paste instead of into the link.
async function printManualRelease(config: ResolvedChangelogOptions, md: string, heading: string) {
  const file = join(tmpdir(), `changelogitea-${config.to.replaceAll('/', '-')}.md`)

  await Bun.write(file, md)
  console.log()
  console.error(colors.yellow(heading))
  console.error(colors.yellow(`  https://${config.baseUrl}/${config.releaseRepo}/releases/new?tag=${encodeURIComponent(config.to)}`))
  console.error(colors.yellow(`  pasting the notes saved to ${file}`))
  console.log()
}

async function release(argv: string[]) {
  const parsed = parse(argv, `usage: changelogitea release [options]

Exits 0 once released, written to --output or shown by --dry, 1 when the release could not be made (no token, the tag not on Forgejo, a shallow clone, an API error) or the Discord post failed, 2 on a usage error.`, shared, { allowNegative: true, positionals: [] })

  const options = await withToken(toOptions(parsed.values))
  let generated: { config: ResolvedChangelogOptions, md: string } | undefined
  let code = 0

  try {
    console.log()
    console.log(colors.dim(`changelo${colors.bold('gitea')} `) + colors.dim(`v${version}`))

    const { config, md, discord, commits } = await generate(options)

    generated = { config, md }

    console.log(colors.cyan(config.from) + colors.dim(' -> ') + colors.blue(config.to) + colors.dim(` (${commits.length} commits)`))
    console.log(colors.dim('--------------'))
    console.log()
    console.log(md.replace(/&nbsp;/g, ''))
    console.log()
    console.log(colors.dim('--------------'))

    if (config.dry) {
      console.log(colors.yellow(config.discordWebhook ? 'Dry run. Release and Discord post skipped.' : 'Dry run. Release skipped.'))
      await printManualRelease(config, md, 'Create it manually at')

      return 0
    }

    if (typeof config.output === 'string') {
      await Bun.write(config.output, md)
      console.log(colors.yellow(`Saved to ${config.output}`))

      return 0
    }

    if (!config.token) {
      console.error(colors.red('No Gitea token found, specify it via GITHUB_TOKEN env. Release skipped.'))
      code = 1
      await printManualRelease(config, md, 'Create it manually at')

      return 1
    }

    if (!await hasTagOnGitea(config.to, config)) {
      console.error(colors.yellow(`Current ref "${colors.bold(config.to)}" is not available as tags on Gitea. Release skipped.`))
      code = 1
      await printManualRelease(config, md, 'Create it manually at')

      return 1
    }

    if (!commits.length && await isRepoShallow()) {
      console.error(colors.yellow('The repo seems to be clone shallowly, which make changelog failed to generate. You might want to specify `fetch-depth: 0` in your CI config.'))
      code = 1
      await printManualRelease(config, md, 'Create it manually at')

      return 1
    }

    await sendRelease(config, md)

    if (config.assets?.length)
      await uploadAssets(config, config.assets)

    if (config.discordWebhook) {
      try {
        await sendDiscordWebhook(config.discordWebhook, discord)
        console.log(colors.green('Posted to Discord'))
      }
      catch (e) {
        console.error(colors.red(`Released, but the Discord post failed: ${String(e)}`))
        code = 1
      }
    }

    return code
  }
  catch (e) {
    console.error(colors.red(String(e)))

    if (e instanceof Error && e.stack !== undefined)
      console.error(colors.dim(e.stack.split('\n').slice(1).join('\n')))

    if (generated)
      await printManualRelease(generated.config, generated.md, 'Failed to create the release. Create it manually at')

    return 1
  }
}

async function undo(argv: string[]) {
  const { values: args, positionals } = parse(argv, `usage: changelogitea undo [tag] [options]

Exits 0 once undone, with nothing to undo, on --dry or when the question is declined, 1 when a step fails, 2 on a usage error.`, undoFlags, { positionals: ['[tag]'] })
  let tag = positionals[0]
  const options = await withToken(toOptions(args))

  try {
    console.log()
    console.log(colors.dim(`changelo${colors.bold('gitea')} `) + colors.dim(`v${version}`))

    if (tag === undefined) {
      tag = (await getGitTags())[0]

      if (tag === undefined) {
        console.log(colors.yellow('No tags found, nothing to undo.'))

        return 0
      }

      console.log(colors.yellow(`No tag specified, using the latest tag "${colors.bold(tag)}".`))
    }

    const config = await resolveConfig({ ...options, to: tag })

    // Prefer plain git for the origin repo so remote tags are handled without
    // relying on a Gitea API token; only fall back to the API for a distinct
    // release repository.
    let originRepo: string | undefined

    try {
      originRepo = await getGiteaRepo()
    }
    catch {}
    const remoteViaGit = Boolean(originRepo) && String(config.releaseRepo) === originRepo

    const release = config.token ? await getRelease(config, tag) : null
    const remoteTag = remoteViaGit
      ? await hasRemoteGitTag(tag)
      : Boolean(config.token) && await hasRemoteTag(config, tag)
    const localTag = await isRefGitTag(tag)

    // Only reset the bump commit when the tag actually points at HEAD,
    // otherwise we'd drop an unrelated commit.
    let commitToReset: { hash: string, subject: string } | undefined

    if (localTag && await getTagCommit(tag) === await getHeadCommit()) {
      commitToReset = { hash: await getHeadCommit(), subject: await getCommitSubject('HEAD') }
    }

    // Ask about the release note (opt-in): --note forces it, --yes without
    // --note skips it, otherwise prompt with a default of "no".
    let deleteNote = false

    if (release) {
      if (args.note)
        deleteNote = true
      else if (!args.yes)
        deleteNote = await ask(`Also delete the Gitea release note "${release.name || tag}"?`)
    }

    const actions: string[] = []

    if (deleteNote && release)
      actions.push(`${colors.red('release note')}  ${tag}`)

    if (remoteTag)
      actions.push(`${colors.red('remote tag')}    ${tag}`)

    if (localTag)
      actions.push(`${colors.red('local tag')}     ${tag}`)

    if (commitToReset)
      actions.push(`${colors.red('commit')}        reset --soft (${commitToReset.hash.slice(0, 7)} "${commitToReset.subject}")`)
    else if (localTag)
      actions.push(colors.dim(`commit        skipped (${tag} is not HEAD)`))

    if (!actions.length) {
      console.log(colors.yellow(`Nothing to undo for "${tag}".`))

      return 0
    }

    console.log()
    console.log(`About to remove on ${colors.bold(String(config.releaseRepo))}:`)
    for (const action of actions)
      console.log(`  - ${action}`)
    console.log()

    if (args.dry) {
      console.log(colors.yellow('Dry run. Nothing removed.'))

      return 0
    }

    if (!args.yes && !await ask('Proceed?')) {
      console.log(colors.yellow('Aborted.'))

      return 0
    }

    if (deleteNote && release) {
      await deleteRelease(config, release.id)
      console.log(colors.green(`Deleted release note ${tag}`))
    }

    if (remoteTag) {
      if (remoteViaGit)
        await deleteRemoteGitTag(tag)
      else
        await deleteRemoteTag(config, tag)

      console.log(colors.green(`Deleted remote tag ${tag}`))
    }

    if (localTag) {
      await deleteLocalTag(tag)
      console.log(colors.green(`Deleted local tag ${tag}`))
    }

    if (commitToReset) {
      await softResetLastCommit()
      console.log(colors.green(`Reset commit ${commitToReset.hash.slice(0, 7)} (changes kept in working tree)`))
    }

    return 0
  }
  catch (e) {
    console.error(colors.red(String(e)))

    if (e instanceof Error && e.stack !== undefined)
      console.error(colors.dim(e.stack.split('\n').slice(1).join('\n')))

    return 1
  }
}

process.exitCode = await runCli({
  name: 'changelogitea',
  version,
  about: 'generate the release notes and publish them',
  replaces: 'writing the release notes by hand and posting them through the Forgejo UI',
  examples: [['changelogitea --dry', 'the notes since the last tag, nothing published'], ['changelogitea undo v1.2.0 --dry', 'what undoing that release would remove']],
  commands: {
    release: { summary: 'generate the release notes and publish them (the default)', run: release },
    undo: { summary: 'undo a release: delete the remote/local tag and reset the bump commit', run: undo },
  },
  defaultCommand: 'release',
})
