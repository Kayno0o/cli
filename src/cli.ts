#!/usr/bin/env bun

import { $ } from 'bun'
import { colors } from '@kaynooo/utils/tools/colors'
import cac from 'cac'
import { version } from '../package.json'
import { deleteRelease, deleteRemoteTag, getRelease, hasRemoteTag, uploadAssets } from './gitea'
import { deleteLocalTag, generate, getCommitSubject, getHeadCommit, getTagCommit, hasTagOnGitea, isRefGitTag, isRepoShallow, resolveConfig, sendRelease, softResetLastCommit } from './index'

const cli = cac('changelogitea')

cli
  .version(version)
  .option('-t, --token <path>', 'Gitea Token')
  .option('--from <ref>', 'From tag')
  .option('--to <ref>', 'To tag')
  .option('--gitea <path>', 'Gitea Repository, e.g. kaynooo/changelogitea')
  .option('--release-gitea <path>', 'Release Gitea Repository, defaults to `gitea`')
  .option('--name <name>', 'Name of the release')
  .option('--contributors', 'Show contributors section')
  .option('--prerelease', 'Mark release as prerelease')
  .option('-d, --draft', 'Mark release as draft')
  .option('--output <path>', 'Output to file instead of sending to Gitea')
  .option('--capitalize', 'Should capitalize for each comment message')
  .option('--emoji', 'Use emojis in section titles', { default: true })
  .option('--group', 'Nest commit messages under their scopes')
  .option('--dry', 'Dry run')
  .option('--assets <paths...>', 'Files to upload as assets to the release. Use quotes to prevent shell glob expansion, e.g., "--assets \'dist/*.js\'"')
  .help()

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

cli
  .command('')
  .action(async (args) => {
    const token = args.token || process.env.GITHUB_TOKEN || await readTokenFromGiteaCli()

    if (token) {
      args.token = token
    }

    let webUrl = ''

    try {
      console.log()
      console.log(colors.dim(`changelo${colors.bold('gitea')} `) + colors.dim(`v${version}`))

      const { config, md, commits } = await generate(args)

      webUrl = `https://${config.baseUrl}/${config.releaseRepo}/releases/new?title=${encodeURIComponent(String(config.name || config.to))}&body=${encodeURIComponent(String(md))}&tag=${encodeURIComponent(String(config.to))}&prerelease=${config.prerelease}`

      console.log(colors.cyan(config.from) + colors.dim(' -> ') + colors.blue(config.to) + colors.dim(` (${commits.length} commits)`))
      console.log(colors.dim('--------------'))
      console.log()
      console.log(md.replace(/&nbsp;/g, ''))
      console.log()
      console.log(colors.dim('--------------'))

      function printWebUrl() {
        console.log()
        console.error(colors.yellow('Using the following link to create it manually:'))
        console.error(colors.yellow(webUrl))
        console.log()
      }

      if (config.dry) {
        console.log(colors.yellow('Dry run. Release skipped.'))
        printWebUrl()

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
        printWebUrl()

        return
      }

      if (!await hasTagOnGitea(config.to, config)) {
        console.error(colors.yellow(`Current ref "${colors.bold(config.to)}" is not available as tags on Gitea. Release skipped.`))
        process.exitCode = 1
        printWebUrl()

        return
      }

      if (!commits.length && await isRepoShallow()) {
        console.error(colors.yellow('The repo seems to be clone shallowly, which make changelog failed to generate. You might want to specify `fetch-depth: 0` in your CI config.'))
        process.exitCode = 1
        printWebUrl()

        return
      }

      await sendRelease(config, md)

      if (args.assets && args.assets.length > 0) {
        await uploadAssets(config, args.assets)
      }
    }
    catch (e: any) {
      console.error(colors.red(String(e)))

      if (e?.stack)
        console.error(colors.dim(e.stack?.split('\n').slice(1).join('\n')))

      if (webUrl) {
        console.log()
        console.error(colors.red('Failed to create the release. Using the following link to create it manually:'))
        console.error(colors.yellow(webUrl))
        console.log()
      }

      process.exit(1)
    }
  })

cli
  .command('undo <tag>', 'Undo a release: delete the remote/local tag and reset the bump commit (optionally the Gitea release note)')
  .option('--note', 'Also delete the Gitea release note (skips the interactive question)')
  .option('--yes', 'Skip confirmation prompts')
  .action(async (tag: string, args: any) => {
    const token = args.token || process.env.GITHUB_TOKEN || await readTokenFromGiteaCli()

    if (token) {
      args.token = token
    }

    try {
      console.log()
      console.log(colors.dim(`changelo${colors.bold('gitea')} `) + colors.dim(`v${version}`))

      const config = await resolveConfig({ ...args, to: tag })

      const release = config.token ? await getRelease(config, tag) : null
      const remoteTag = config.token ? await hasRemoteTag(config, tag) : false
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
  })

cli.parse()
