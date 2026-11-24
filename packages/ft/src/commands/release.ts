import type { ExitRow } from '@kaynooo/cli-kit'
import type { Manifest } from './release-version'
import type { Followed } from './watch'
import { basename, join } from 'node:path'
import process from 'node:process'
import {
  deleteLocalTag,
  deleteRelease,
  deleteRemoteGitTag,
  deleteRemoteTag,
  forgeName,
  generate,
  getCommitSubject,
  getGiteaRepo,
  getGitTags,
  getHeadCommit,
  getRelease,
  getTagCommit,
  hasRemoteGitTag,
  hasRemoteTag,
  isHeadPushed,
  isRefGitTag,
  resolveConfig,
  sendRelease,
  softResetLastCommit,
  uploadAssets,
} from '@kaynooo/cli-changelog'
import { duration, exitCodeOf, fail, holdSignals, jsonOption, parse, printJson, runHint, warn } from '@kaynooo/cli-kit'
import { confirm } from '@kaynooo/cli-kit/prompt'
import { sendDiscordWebhook } from '@kaynooo/utils/discord'
import { $ } from 'bun'
import { defaultBranch, fetchBranch, git, tagsAt } from '../git'
import { ciJson, recentRuns } from '../runs'
import { NO_RUN, pushToOrigin, testsPass } from './release-checks'
import { changedPackages, parseTargets, publishable } from './release-many'
import { printPlan } from './release-plan'
import { commitPackageBump, packageDir, rollBack, settleMilestone, waitForRegistry } from './release-steps'
import { LEVELS, taggedVersion, VERSION } from './release-version'
import { followRuns } from './watch'

const SEVERAL = /[,:]/

const usage = `fg release <patch|minor|major|x.y.z>
fg release <level> -p <a,b:minor,...>
fg release <level> --changed
fg release <level> --all
fg release --tagged
fg release notes [--to <tag>] [--from <tag>] [--dry-run] [--discord-webhook <url>]
fg release undo [tag] [--note] [--force] [--yes] [--dry-run]

Cuts a release from the default branch: waits for the runs on HEAD, bumps and tags with \`bun pm version\`, pushes, then waits for the runs and the registry.
--changed selects every publishable package under packages/ with commits since its last <folder>-v* tag.
--notes publishes generated conventional-commit release notes to Forgejo, GitHub, or GitLab (and posts to Discord when --discord-webhook or DISCORD_WEBHOOK is set).
\`fg release undo\` removes the tag (and optionally the release note) and resets HEAD only when HEAD is not already pushed to a remote branch (unless --force).`
const EXITS: ExitRow[] = [[0, 'released, planned or undone'], [1, 'a run fails, origin refuses a push or the registry/release API fails'], [2, 'a timeout, a stalled queue, a refusal before anything ran (another branch, uncommitted changes, origin ahead) or a usage error']]

const options = {
  'tagged': { type: 'boolean', description: 'push the version commit and tag already at HEAD instead of bumping' },
  'package': { type: 'string', short: 'p', description: 'workspace folder to release, a path or a name under packages/, several separated by commas' },
  'changed': { type: 'boolean', description: 'release every publishable package with commits since its last <folder>-v* tag' },
  'all': { type: 'boolean', description: 'release every published package of the workspace in one push' },
  'notes': { type: 'boolean', description: 'generate and publish release notes on Forgejo, GitHub or GitLab after pushing' },
  'discord-webhook': { type: 'string', description: 'Discord webhook URL to post release notes to (defaults to DISCORD_WEBHOOK)' },
  'assets': { type: 'string', multiple: true, description: 'asset files or globs to upload to the published release' },
  'no-registry': { type: 'boolean', description: 'do not wait for the registry to serve the new version' },
  'dry-run': { type: 'boolean', description: 'print what the release would do, changing nothing' },
  'timeout': { type: 'string', short: 't', description: 'how long to wait for the runs (15m), a bare number in minutes' },
  'json': jsonOption('{released, tag, package, version, status, runs, failedJobs, url} on stdout and the progress on stderr, an array with several packages; not with --dry-run'),
} as const

export type Released = ReturnType<typeof ciJson> & { released: boolean, tag: string, package: string | null, version: string, notesUrl?: string | null }

interface Bumped {
  dir: string | undefined
  prefix: string
  tag: string
  head: string
}

async function publishReleaseNotes(tag: string, options: { dry?: boolean | undefined, discordWebhook?: string | undefined, assets?: string[] | undefined, from?: string | undefined, output?: string | undefined, json?: boolean | undefined, say: (line: string) => void }): Promise<string | null> {
  const { config, md, discord, commits } = await generate({
    to: tag,
    ...options.from === undefined ? {} : { from: options.from },
    ...options.dry === undefined ? {} : { dry: options.dry },
    ...options.output === undefined ? {} : { output: options.output },
    ...options.discordWebhook === undefined ? {} : { discordWebhook: options.discordWebhook },
    ...options.assets === undefined ? {} : { assets: options.assets },
  })

  if (options.dry === true) {
    if (options.json === true)
      printJson({ status: 'dry-run', from: config.from, to: config.to, commits: commits.length, notes: md })
    else
      options.say(md)

    return null
  }

  if (typeof options.output === 'string') {
    await Bun.write(options.output, md)
    options.say(`saved release notes to ${options.output}`)

    return null
  }

  if (!config.token) {
    warn(`no ${forgeName(config)} token found, skipping release notes for ${tag}`)

    return null
  }

  const url = await sendRelease(config, md)

  if (config.assets?.length) {
    const failed = await uploadAssets(config, config.assets)

    if (failed > 0)
      warn(`${failed} release asset upload(s) failed for ${tag}`)
  }

  if (config.discordWebhook) {
    try {
      await sendDiscordWebhook(config.discordWebhook, discord)
      options.say(`posted ${tag} to Discord`)
    }
    catch (error) {
      warn(`released ${tag}, but the Discord post failed`, error instanceof Error ? error.message : String(error))
    }
  }

  return url
}

async function releaseNotes(args: string[]): Promise<number> {
  const { values } = parse(args, 'fg release notes [--to <tag>] [--from <tag>] [--output <file>] [--dry-run] [--discord-webhook <url>] [--assets <glob>] [--json]', {
    'from': { type: 'string', description: 'start ref/tag' },
    'to': { type: 'string', description: 'end tag (defaults to tag at HEAD or current branch)' },
    'output': { type: 'string', short: 'o', description: 'write Markdown notes to a file instead of publishing' },
    'discord-webhook': { type: 'string', description: 'Discord webhook URL (defaults to DISCORD_WEBHOOK)' },
    'assets': { type: 'string', multiple: true, description: 'files/globs to upload as release assets' },
    'dry-run': { type: 'boolean', description: 'print generated notes without publishing' },
    'json': jsonOption('{status, from, to, commits, notes, url}'),
  }, { exits: EXITS })

  const json = values.json === true
  const say = json ? console.error : console.log
  const tag = values.to ?? (await tagsAt('HEAD'))[0] ?? await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const url = await publishReleaseNotes(tag, {
    dry: values['dry-run'] === true,
    from: values.from,
    output: values.output,
    discordWebhook: values['discord-webhook'],
    assets: values.assets,
    json,
    say,
  })

  if (json && values['dry-run'] !== true) {
    let status = 'released'

    if (values.output !== undefined)
      status = 'saved'
    else if (url === null)
      status = 'skipped'

    printJson({ status, to: tag, url })
  }

  return 0
}

async function releaseUndo(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, 'fg release undo [tag] [--note] [--force] [--yes] [--dry-run] [--json]', {
    'note': { type: 'boolean', description: 'also delete the release note on the forge' },
    'force': { type: 'boolean', description: 'reset HEAD even when already pushed to a remote branch' },
    'yes': { type: 'boolean', short: 'y', description: 'skip confirmation prompt' },
    'dry-run': { type: 'boolean', description: 'preview what would be removed without changing anything' },
    'json': jsonOption('{status, tag, releaseNote, remoteTag, localTag, commitReset}'),
  }, { positionals: ['[tag]'], exits: EXITS })

  const json = values.json === true
  const say = json ? console.error : console.log
  const tag = positionals[0] ?? (await getGitTags())[0]

  if (tag === undefined || tag === '') {
    if (json)
      printJson({ status: 'nothing', tag: null, releaseNote: false, remoteTag: false, localTag: false, commitReset: null })
    else
      say('no tags found, nothing to undo')

    return 0
  }

  const config = await resolveConfig({ to: tag })
  let originRepo: string | undefined

  try {
    originRepo = await getGiteaRepo()
  }
  catch {
    // No origin
  }

  const remoteViaGit = Boolean(originRepo) && String(config.releaseRepo) === originRepo
  const existingRelease = config.token ? await getRelease(config, tag) : null
  const remoteTag = remoteViaGit ? await hasRemoteGitTag(tag) : Boolean(config.token) && await hasRemoteTag(config, tag)
  const localTag = await isRefGitTag(tag)
  let commitToReset: { hash: string, subject: string } | undefined
  let skippedPushed = false

  if (localTag && await getTagCommit(tag) === await getHeadCommit()) {
    if (values.force !== true && await isHeadPushed())
      skippedPushed = true
    else
      commitToReset = { hash: await getHeadCommit(), subject: await getCommitSubject('HEAD') }
  }

  const deleteNote = existingRelease !== null && values.note === true
  const result = { status: 'undone', tag, releaseNote: deleteNote, remoteTag, localTag, commitReset: commitToReset ?? null }

  if (!deleteNote && !remoteTag && !localTag && commitToReset === undefined) {
    if (skippedPushed)
      warn(`HEAD (${tag}) is already pushed to a remote branch; pass --force to reset it`)

    if (json)
      printJson({ ...result, status: 'nothing' })
    else
      say(`nothing to undo for ${tag}`)

    return 0
  }

  if (skippedPushed)
    warn('skipping commit reset because HEAD is already pushed to a remote branch (pass --force to reset)')

  if (values['dry-run'] === true) {
    if (json)
      printJson({ ...result, status: 'dry-run' })
    else
      say(`would undo ${tag}: ${[deleteNote ? 'release note' : '', remoteTag ? 'remote tag' : '', localTag ? 'local tag' : '', commitToReset === undefined ? '' : `reset ${commitToReset.hash.slice(0, 7)}`].filter(Boolean).join(', ')}`)

    return 0
  }

  if (json && values.yes !== true)
    fail('--json requires --yes (or --dry-run to preview)', 2)

  if (values.yes !== true && await confirm(`Undo release ${tag}?`, { default: false, hint: 'pass --yes to confirm' }) !== true) {
    say('aborted')

    return 0
  }

  if (deleteNote) {
    await deleteRelease(config, existingRelease.id, tag)
    say(`deleted release note ${tag}`)
  }

  if (remoteTag) {
    if (remoteViaGit)
      await deleteRemoteGitTag(tag)
    else
      await deleteRemoteTag(config, tag)

    say(`deleted remote tag ${tag}`)
  }

  if (localTag) {
    await deleteLocalTag(tag)
    say(`deleted local tag ${tag}`)
  }

  if (commitToReset !== undefined) {
    await softResetLastCommit()
    say(`reset commit ${commitToReset.hash.slice(0, 7)} (changes kept in working tree)`)
  }

  if (json)
    printJson(result)

  return 0
}

export async function release(args: string[]): Promise<number> {
  if (args[0] === 'notes')
    return releaseNotes(args.slice(1))

  if (args[0] === 'undo')
    return releaseUndo(args.slice(1))

  const parsed = parse(args, usage, options, { exits: EXITS })

  const { values, positionals } = parsed
  const json = values.json === true
  const say = json ? console.error : console.log

  if (json && values['dry-run'] === true)
    fail('--json does not take --dry-run')

  const level = positionals[0]
  const tagged = values.tagged === true

  if (tagged === (level !== undefined))
    fail(`give a level or --tagged\n\n${usage}`)

  if (level !== undefined && !LEVELS.has(level) && !VERSION.test(level))
    fail(`${level} is no level nor x.y.z version`)

  const selectors = [values.all === true, values.changed === true, values.package !== undefined].filter(Boolean).length

  if (selectors > 1)
    fail('give at most one of --all, --changed or --package')

  if ((values.all === true || values.changed === true) && (tagged || level === undefined))
    fail('--all and --changed take a level, not --tagged')

  let packageSpec = values.package

  if (values.changed === true) {
    const changed = await changedPackages()

    if (changed.length === 0) {
      if (json)
        printJson([])
      else
        say('nothing changed since the last tags')

      return 0
    }

    for (const entry of changed)
      say(`${entry.folder} changed since ${entry.since ?? 'the start'}`)

    packageSpec = changed.map(entry => entry.folder).join(',')
  }

  const several = values.all === true || values.changed === true || SEVERAL.test(packageSpec ?? '')

  if (several && (tagged || level === undefined))
    fail('--all, --changed and several packages take a level, not --tagged')

  // Every package is found before anything runs, so a wrong folder stops the release before the tests are waited for.
  const targets = several && level !== undefined
    ? await Promise.all(parseTargets(packageSpec ?? (await publishable()).join(','), level).map(async target => ({ level: target.level, dir: await packageDir(target.folder) })))
    : [{ level, dir: packageSpec === undefined ? undefined : await packageDir(packageSpec) }]

  if (targets.length === 0)
    fail('no package to release: --all/--changed found no published package, or --package named none')

  const timeout = duration(values.timeout, 'timeout', 15 * 60_000, 'm')
  const prefixOf = (dir: string | undefined): string => dir === undefined ? 'v' : `${basename(dir)}-v`
  const branch = await defaultBranch()
  const current = await git(['branch', '--show-current'])

  if (current !== branch)
    fail(`a release is cut from ${branch}, not ${current || 'a detached HEAD'}`, 2, runHint(`git switch ${branch}`))

  if (await git(['status', '--porcelain']) !== '')
    fail('the tree has uncommitted changes', 2, runHint('gst', 'see them, then commit them with gc'))

  // A push origin would refuse is caught before the bump; a new repository's origin has no branch yet, which the push of HEAD makes.
  if (await fetchBranch(branch) && (await $`git merge-base --is-ancestor ${`origin/${branch}`} HEAD`.quiet().nothrow()).exitCode !== 0)
    fail(`origin/${branch} has commits HEAD lacks`, 2, runHint(`git pull --rebase origin ${branch}`))

  // With --tagged, HEAD is the version commit and the tests run on the one below it.
  const base = await git(['rev-parse', tagged ? 'HEAD~1' : 'HEAD'])

  if (values['dry-run'] === true)
    return printPlan({ releases: targets.map(({ level, dir }) => ({ level, dir, prefix: prefixOf(dir) })), branch, base, timeout, registry: values['no-registry'] !== true })

  if (!await testsPass(base, branch, timeout, json))
    fail(`the runs on ${base.slice(0, 7)} failed, so nothing was bumped or tagged`, 1, runHint(`fg runs --sha ${base.slice(0, 7)}`, 'list the runs, then fg logs <id> reads the failure'))

  // Read before the bump, so a failure here leaves nothing to undo.
  const preBump = await git(['rev-parse', 'HEAD'])
  const before = (await recentRuns(1))[0]?.id ?? 0
  const held = holdSignals()
  const signalOf = () => held.signal
  const bumped: Bumped[] = []
  let pushed = false
  let isPushUnknown = false

  try {
    for (const { level, dir } of targets) {
      const prefix = prefixOf(dir)

      if (level !== undefined) {
        const bump = dir === undefined
          ? await $`bun pm version ${level}`.quiet().nothrow()
          : await $`bun pm version ${level} --no-git-tag-version`.cwd(dir).quiet().nothrow()

        if (bump.exitCode !== 0)
          fail(`bun pm version ${level}${dir === undefined ? '' : ` in ${basename(dir)}`}: ${bump.stderr.toString().trim() || bump.stdout.toString().trim()}`)

        if (dir !== undefined)
          await commitPackageBump(dir, prefix)
      }

      const tag = (await tagsAt('HEAD')).find(name => taggedVersion(name, prefix) !== undefined)

      if (tag === undefined)
        fail(tagged ? `HEAD carries no ${prefix}* tag` : `the bump made no ${prefix}* tag`)

      bumped.push({ dir, prefix, tag, head: await git(['rev-parse', 'HEAD']) })

      if (held.signal !== undefined)
        fail(`interrupted by ${held.signal} before the push`, exitCodeOf(null, held.signal))
    }

    const tags = bumped.map(each => each.tag)
    let push

    try {
      push = await pushToOrigin([`HEAD:refs/heads/${branch}`, ...tags.map(tag => `refs/tags/${tag}`)], child => held.forward(child), true)
    }
    catch (error) {
      isPushUnknown = true
      fail(`${error instanceof Error ? error.message : String(error)}, so ${tags.join(', ')} and ${tags.length === 1 ? 'its commit are' : 'their commits are'} kept: the push may have landed`, 2, tags.length === 1 ? `git ls-remote origin refs/tags/${tags[0]} tells; if it is there, fg release --tagged waits for its runs` : `git ls-remote --tags origin tells; if they are there, fg watch --after ${before} waits for their runs`)
    }

    if (push.code !== 0) {
      const signal = signalOf()
      const kept = tagged ? `${tags.join(', ')} and its commit are kept for a retry` : `${tags.join(', ')} and ${tags.length === 1 ? 'its commit were' : 'their commits were'} dropped for a clean retry`

      fail(`origin refused the push${signal === undefined ? '' : `, or ${signal} interrupted it`}, so ${kept}:\n${push.stderr.trim()}`, signal === undefined ? 1 : exitCodeOf(null, signal))
    }

    pushed = true
  }
  finally {
    held.release()

    if (!pushed && !isPushUnknown && !tagged)
      await rollBack(preBump, targets.flatMap(target => target.dir === undefined ? [] : [target.dir]))
  }

  const heads = new Set(bumped.map(each => each.head))
  const manifests = await Promise.all(bumped.map(async (each) => {
    const file = Bun.file(join(each.dir ?? '.', 'package.json'))

    return await file.exists() ? await file.json() as Manifest : undefined
  }))
  const released = new Set<Bumped>()
  const notesUrls = new Map<Bumped, string | null>()
  let followed: Followed = { code: 0, runs: [], failedJobs: [] }

  const report = (): void => {
    if (!json)
      return

    const results: Released[] = bumped.map((each, index) => {
      const own = followed.runs.filter(run => run.prettyref === each.tag || run.prettyref === branch)
      const notesUrl = notesUrls.get(each)

      return {
        released: released.has(each),
        tag: each.tag,
        package: manifests[index]?.name ?? null,
        version: each.tag.slice(each.prefix.length),
        ...notesUrl === undefined ? {} : { notesUrl },
        ...ciJson(own, followed.failedJobs.filter(job => own.some(run => run.id === job.run))),
      }
    })

    printJson(several ? results : results[0])
  }

  try {
    const late = signalOf()

    if (late !== undefined)
      fail(`interrupted by ${late} after ${bumped.map(each => each.tag).join(', ')} ${bumped.length === 1 ? 'was pushed: its runs are' : 'were pushed: their runs are'} not waited for`, exitCodeOf(null, late))

    say(`pushed ${branch} and ${bumped.map(each => each.tag).join(', ')}, waiting for their runs`)
    followed = await followRuns(runs => runs.filter(run => run.id > before && heads.has(run.commit_sha)), timeout, undefined, NO_RUN, json ? process.stderr : process.stdout, { json })

    if (followed.code !== 0) {
      report()

      return followed.code
    }

    for (const [index, each] of bumped.entries()) {
      const pkg = manifests[index]
      const version = each.tag.slice(each.prefix.length)

      if (values['no-registry'] !== true && pkg?.name !== undefined && pkg.private !== true) {
        if (!await waitForRegistry(pkg.name, version)) {
          const rest = bumped.slice(index + 1).map(next => next.tag)

          fail(`the runs passed but the registry does not serve ${pkg.name}@${version}${rest.length === 0 ? '' : `, so ${rest.join(', ')} ${rest.length === 1 ? 'is' : 'are'} pushed but not waited for`}: read the publish job with \`fg logs\``, 1)
        }

        say(`released ${pkg.name}@${version}`)
      }
      else {
        say(`released ${each.tag}`)
      }

      if (values.notes === true) {
        const notesUrl = await publishReleaseNotes(each.tag, {
          discordWebhook: values['discord-webhook'],
          assets: values.assets,
          json,
          say,
        })

        notesUrls.set(each, notesUrl)
      }

      await settleMilestone(version, each.tag, say)
      released.add(each)
    }

    report()

    return 0
  }
  catch (error) {
    report()

    throw error
  }
}

export { limits, testsPass } from './release-checks'
export { changedPackages } from './release-many'
export { commitPackageBump, settleMilestone } from './release-steps'
export { nextVersion, taggedVersion } from './release-version'
