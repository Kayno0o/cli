#!/usr/bin/env bun

import type { ParseArgsOptionsConfig } from 'node:util'
import type { ChangelogOptions, ResolvedChangelogOptions } from './types'
import { $ } from 'bun'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { sendDiscordWebhook } from '@kaynooo/utils'
import { colors } from '@kaynooo/utils/tools/colors'
import { version } from '../package.json'
import { deleteRelease, deleteRemoteTag, getRelease, hasRemoteTag, uploadAssets } from './gitea'
import { deleteLocalTag, deleteRemoteGitTag, generate, getCommitSubject, getGiteaRepo, getGitTags, getHeadCommit, getTagCommit, hasRemoteGitTag, hasTagOnGitea, isRefGitTag, isRepoShallow, resolveConfig, sendRelease, softResetLastCommit } from './index'

const flags = {
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
  'note': { type: 'boolean', description: 'undo: also delete the Gitea release note (skips the question)' },
  'yes': { type: 'boolean', description: 'undo: skip confirmation prompts' },
  'help': { type: 'boolean', short: 'h', description: 'Show this help' },
  'version': { type: 'boolean', short: 'v', description: 'Show the version' },
} as const satisfies Record<string, ParseArgsOptionsConfig[string] & { description: string }>

function printHelp() {
  const rows = Object.entries(flags).map(([name, flag]) => {
    const short = 'short' in flag ? `-${flag.short}, ` : '    '
    const value = flag.type === 'string' ? ` <${name === 'assets' ? 'paths' : 'value'}>` : ''

    return [`  ${short}--${name}${value}`, flag.description] as const
  })
  const width = Math.max(...rows.map(([usage]) => usage.length)) + 2

  console.log(`changelogitea v${version}

Usage:
  changelogitea [options]       Generate the release notes and publish them
  changelogitea undo [tag]      Undo a release: delete the remote/local tag and reset the bump commit

Options:
${rows.map(([usage, description]) => usage.padEnd(width) + description).join('\n')}`)
}

const { values: args, positionals } = parseArgs({ args: process.argv.slice(2), options: flags, allowPositionals: true, allowNegative: true })

// The flags as config options; an absent flag stays undefined so the config file keeps the say.
function toOptions(): ChangelogOptions {
  return {
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
  }
}

function ask(message: string) {
  // eslint-disable-next-line no-alert
  return confirm(colors.yellow(message))
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
  const token = options.token || process.env.GITHUB_TOKEN || await readTokenFromGiteaCli()

  return token ? { ...options, token } : options
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

async function release() {
  const options = await withToken(toOptions())
  let generated: { config: ResolvedChangelogOptions, md: string } | undefined

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

      return
    }

    if (typeof config.output === 'string') {
      await Bun.write(config.output, md)
      console.log(colors.yellow(`Saved to ${config.output}`))

      return
    }

    if (!config.token) {
      console.error(colors.red('No Gitea token found, specify it via GITHUB_TOKEN env. Release skipped.'))
      process.exitCode = 1
      await printManualRelease(config, md, 'Create it manually at')

      return
    }

    if (!await hasTagOnGitea(config.to, config)) {
      console.error(colors.yellow(`Current ref "${colors.bold(config.to)}" is not available as tags on Gitea. Release skipped.`))
      process.exitCode = 1
      await printManualRelease(config, md, 'Create it manually at')

      return
    }

    if (!commits.length && await isRepoShallow()) {
      console.error(colors.yellow('The repo seems to be clone shallowly, which make changelog failed to generate. You might want to specify `fetch-depth: 0` in your CI config.'))
      process.exitCode = 1
      await printManualRelease(config, md, 'Create it manually at')

      return
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
        console.error(colors.red(`Released, but the Discord post failed: ${e}`))
        process.exitCode = 1
      }
    }
  }
  catch (e: any) {
    console.error(colors.red(String(e)))

    if (e?.stack)
      console.error(colors.dim(e.stack?.split('\n').slice(1).join('\n')))

    if (generated)
      await printManualRelease(generated.config, generated.md, 'Failed to create the release. Create it manually at')

    process.exit(1)
  }
}

async function undo(tag: string | undefined) {
  const options = await withToken(toOptions())

  try {
    console.log()
    console.log(colors.dim(`changelo${colors.bold('gitea')} `) + colors.dim(`v${version}`))

    if (!tag) {
      tag = (await getGitTags())[0]

      if (!tag) {
        console.log(colors.yellow('No tags found, nothing to undo.'))

        return
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
      : (config.token ? await hasRemoteTag(config, tag) : false)
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
        deleteNote = ask(`Also delete the Gitea release note "${release.name || tag}"?`)
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

      return
    }

    console.log()
    console.log(`About to remove on ${colors.bold(String(config.releaseRepo))}:`)
    for (const action of actions)
      console.log(`  - ${action}`)
    console.log()

    if (args.dry) {
      console.log(colors.yellow('Dry run. Nothing removed.'))

      return
    }

    if (!args.yes && !ask('Proceed?')) {
      console.log(colors.yellow('Aborted.'))

      return
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
  }
  catch (e: any) {
    console.error(colors.red(String(e)))

    if (e?.stack)
      console.error(colors.dim(e.stack?.split('\n').slice(1).join('\n')))

    process.exit(1)
  }
}

if (args.help) {
  printHelp()
}
else if (args.version) {
  console.log(version)
}
else if (positionals[0] === 'undo') {
  await undo(positionals[1])
}
else if (positionals.length) {
  console.error(colors.red(`Unknown command "${positionals[0]}"`))
  printHelp()
  process.exitCode = 1
}
else {
  await release()
}
