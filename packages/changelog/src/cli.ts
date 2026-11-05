#!/usr/bin/env -S bun --config=/dev/null

import type { ResolvedChangelogOptions } from './types'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Exit, fail, parse, printJson, role, runCli } from '@kaynooo/cli-kit'
import { confirm } from '@kaynooo/cli-kit/prompt'
import { sendDiscordWebhook } from '@kaynooo/utils'
import { version } from '../package.json'
import { aliasFlags, shared, shouldAskNote, toOptions, undoFlags, withToken } from './flags'
import { deleteRelease, deleteRemoteTag, getRelease, hasRemoteTag, uploadAssets } from './gitea'
import { deleteLocalTag, deleteRemoteGitTag, generate, getCommitSubject, getGiteaRepo, getGitTags, getHeadCommit, getTagCommit, hasRemoteGitTag, hasTagOnGitea, isRefGitTag, isRepoShallow, resolveConfig, sendRelease, softResetLastCommit } from './index'
import { err, out, stdoutToStderr } from './ui'

type Report = Record<string, unknown>

// Runs a command under --json: its logging goes to stderr and the report it hands over is printed as the only thing on stdout.
async function reporting(argv: string[], run: (argv: string[], report: (value: Report) => unknown) => Promise<number>): Promise<number> {
  const end = argv.indexOf('--')
  const json = (end === -1 ? argv : argv.slice(0, end)).includes('--json')
  const reports: Report[] = []
  const code = await stdoutToStderr(json, async () => run(argv, value => reports.push(value)))

  if (json && reports[0] !== undefined)
    printJson(reports[0])

  return code
}

// An unexpected error ends as a shared `error: changelog <command>: message`, its stack shown only under --debug.
function failed(e: unknown, debug: boolean | undefined): never {
  if (e instanceof Exit)
    throw e

  if (debug === true && e instanceof Error && e.stack !== undefined)
    console.error(err().dim(e.stack.split('\n').slice(1).join('\n')))

  return fail(e instanceof Error ? e.message : String(e), 1)
}

async function ask(question: string) {
  return await confirm(question, { default: false, hint: 'pass --yes to skip the questions' }) === true
}

// Forgejo's new-release page only reads `tag`, so the notes go to a file to paste instead of into the link.
async function printManualRelease(config: ResolvedChangelogOptions, md: string, heading: string) {
  const file = join(tmpdir(), `changelog-${config.to.replaceAll('/', '-')}.md`)

  await Bun.write(file, md)
  console.log()
  console.error(err().yellow(heading))
  console.error(err().yellow(`  https://${config.baseUrl}/${config.releaseRepo}/releases/new?tag=${encodeURIComponent(config.to)}`))
  console.error(err().yellow(`  pasting the notes saved to ${file}`))
  console.log()
}

async function release(argv: string[], report: (value: Report) => unknown) {
  const parsed = parse(argv, `usage: changelog release [options]

Exits 0 once released, written to --output or shown by --dry-run, 1 when the release could not be made (no token, the tag not on Forgejo, a shallow clone, an API error), an asset upload or the Discord post failed, 2 on a usage error.

--json prints {command, status (released, dry-run or saved), from, to, commits, notes, url, output, assetsFailed, discord (posted, failed or null)} on stdout and the progress on stderr; a failure is {error} on stderr.`, shared, { allowNegative: true, positionals: [] })

  const options = withToken(toOptions(parsed.values))
  let generated: { config: ResolvedChangelogOptions, md: string } | undefined
  let code = 0

  try {
    console.log()
    console.log(out().dim(`changelog v${version}`))

    const { config, md, discord, commits } = await generate(options)
    const result = { command: 'release', status: 'released', from: config.from, to: config.to, commits: commits.length, notes: md, url: null as string | null, output: null as string | null, assetsFailed: 0, discord: null as string | null }

    generated = { config, md }

    console.log(role('accent', process.stdout)(config.from) + out().dim(' -> ') + role('path', process.stdout)(config.to) + out().dim(` (${commits.length} commits)`))
    console.log(out().dim('--------------'))
    console.log()
    console.log(md.replace(/&nbsp;/g, ''))
    console.log()
    console.log(out().dim('--------------'))

    if (config.dry) {
      console.log(out().yellow(config.discordWebhook ? 'Dry run. Release and Discord post skipped.' : 'Dry run. Release skipped.'))
      await printManualRelease(config, md, 'Create it manually at')
      report({ ...result, status: 'dry-run' })

      return 0
    }

    if (typeof config.output === 'string') {
      await Bun.write(config.output, md)
      console.log(out().yellow(`Saved to ${config.output}`))
      report({ ...result, status: 'saved', output: config.output })

      return 0
    }

    if (!config.token) {
      await printManualRelease(config, md, 'Create it manually at')
      fail('no Forgejo token found, pass --token or set GITHUB_TOKEN, release skipped', 1)
    }

    if (!await hasTagOnGitea(config.to, config)) {
      await printManualRelease(config, md, 'Create it manually at')
      fail(`the ref "${config.to}" is not available as a tag on Forgejo, release skipped`, 1)
    }

    if (!commits.length && await isRepoShallow()) {
      await printManualRelease(config, md, 'Create it manually at')
      fail('the repo seems to be cloned shallowly, which makes changelog fail to generate, specify `fetch-depth: 0` in your CI config', 1)
    }

    result.url = await sendRelease(config, md)

    if (config.assets?.length) {
      result.assetsFailed = await uploadAssets(config, config.assets)

      if (result.assetsFailed > 0)
        code = 1
    }

    if (config.discordWebhook) {
      try {
        await sendDiscordWebhook(config.discordWebhook, discord)
        console.log(out().green('Posted to Discord'))
        result.discord = 'posted'
      }
      catch (e) {
        console.error(err().red(`Released, but the Discord post failed: ${String(e)}`))
        result.discord = 'failed'
        code = 1
      }
    }

    report(result)

    return code
  }
  catch (e) {
    if (generated && !(e instanceof Exit))
      await printManualRelease(generated.config, generated.md, 'Failed to create the release. Create it manually at')

    return failed(e, parsed.values.debug)
  }
}

async function undo(argv: string[], report: (value: Report) => unknown) {
  const { values: args, positionals } = parse(argv, `usage: changelog undo [tag] [options]

Exits 0 once undone, with nothing to undo, on --dry-run or when the question is declined, 1 when a step fails, 2 on a usage error.

--json prints {command, status (undone, nothing, dry-run or declined), tag, releaseNote, remoteTag, localTag, commitReset: {hash, subject} or null} on stdout and the progress on stderr, each flag true when that step is (or, on a dry run, would be) taken. It asks no question: the release note is deleted with --note only, and anything to remove needs --yes or --dry-run (exit 2 otherwise).`, undoFlags, { positionals: ['[tag]'] })
  const json = args.json === true
  let tag = positionals[0]
  const options = withToken(toOptions(args))

  try {
    console.log()
    console.log(out().dim(`changelog v${version}`))

    if (tag === undefined || tag === '') {
      tag = (await getGitTags())[0]

      if (tag === undefined) {
        console.log(out().yellow('No tags found, nothing to undo.'))
        report({ command: 'undo', status: 'nothing', tag: null, releaseNote: false, remoteTag: false, localTag: false, commitReset: null })

        return 0
      }

      console.log(out().yellow(`No tag specified, using the latest tag "${out().bold(tag)}".`))
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

    // Deleting the release note is opt-in: --note forces it, --yes and --dry-run skip the question, otherwise it defaults to "no".
    const deleteNote = release !== null && (args.note === true || (!json && shouldAskNote({ release, note: args.note, yes: args.yes, dry: args['dry-run'] }) && await ask(`Also delete the Forgejo release note "${release.name || tag}"?`)))

    const actions: string[] = []

    if (deleteNote)
      actions.push(`${out().red('release note')}  ${tag}`)

    if (remoteTag)
      actions.push(`${out().red('remote tag')}    ${tag}`)

    if (localTag)
      actions.push(`${out().red('local tag')}     ${tag}`)

    if (commitToReset)
      actions.push(`${out().red('commit')}        reset --soft (${commitToReset.hash.slice(0, 7)} "${commitToReset.subject}")`)
    else if (localTag)
      actions.push(out().dim(`commit        skipped (${tag} is not HEAD)`))

    const result = { command: 'undo', status: 'undone', tag, releaseNote: deleteNote, remoteTag, localTag, commitReset: commitToReset === undefined ? null : { hash: commitToReset.hash, subject: commitToReset.subject } }

    if (!actions.length) {
      console.log(out().yellow(`Nothing to undo for "${tag}".`))
      report({ ...result, status: 'nothing' })

      return 0
    }

    if (json && args.yes !== true && args['dry-run'] !== true)
      fail('--json asks no question, so removing needs --yes (or --dry-run to preview)')

    console.log()
    console.log(`About to remove on ${out().bold(String(config.releaseRepo))}:`)
    for (const action of actions)
      console.log(`  - ${action}`)
    console.log()

    if (args['dry-run']) {
      console.log(out().yellow('Dry run. Nothing removed.'))
      report({ ...result, status: 'dry-run' })

      return 0
    }

    if (!args.yes && !await ask('Proceed?')) {
      console.log(out().yellow('Aborted.'))
      report({ ...result, status: 'declined', releaseNote: false, remoteTag: false, localTag: false, commitReset: null })

      return 0
    }

    if (deleteNote) {
      await deleteRelease(config, release.id)
      console.log(out().green(`Deleted release note ${tag}`))
    }

    if (remoteTag) {
      if (remoteViaGit)
        await deleteRemoteGitTag(tag)
      else
        await deleteRemoteTag(config, tag)

      console.log(out().green(`Deleted remote tag ${tag}`))
    }

    if (localTag) {
      await deleteLocalTag(tag)
      console.log(out().green(`Deleted local tag ${tag}`))
    }

    if (commitToReset) {
      await softResetLastCommit()
      console.log(out().green(`Reset commit ${commitToReset.hash.slice(0, 7)} (changes kept in working tree)`))
    }

    report(result)

    return 0
  }
  catch (e) {
    return failed(e, args.debug)
  }
}

process.exitCode = await runCli({
  name: 'changelog',
  about: 'generate the release notes and publish them',
  replaces: 'writing the release notes by hand and posting them through the Forgejo UI',
  examples: [['changelog --dry-run', 'the notes since the last tag, nothing published'], ['changelog undo v1.2.0 --dry-run', 'what undoing that release would remove']],
  commands: {
    release: { summary: 'generate the release notes and publish them (the default)', run: async argv => reporting(aliasFlags(argv), release) },
    undo: { summary: 'undo a release: delete the remote/local tag and reset the bump commit', run: async argv => reporting(aliasFlags(argv), undo) },
  },
  defaultCommand: 'release',
})
