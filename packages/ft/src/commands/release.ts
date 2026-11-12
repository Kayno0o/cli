import type { ExitRow } from '@kaynooo/cli-kit'
import type { Manifest } from './release-version'
import type { Followed } from './watch'
import { basename, join } from 'node:path'
import process from 'node:process'
import { duration, exitCodeOf, fail, holdSignals, jsonOption, parse, printJson, runHint } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { defaultBranch, fetchBranch, git, tagsAt } from '../git'
import { ciJson, recentRuns } from '../runs'
import { NO_RUN, pushToOrigin, testsPass } from './release-checks'
import { parseTargets, publishable } from './release-many'
import { printPlan } from './release-plan'
import { commitPackageBump, packageDir, rollBack, settleMilestone, waitForRegistry } from './release-steps'
import { LEVELS, taggedVersion, VERSION } from './release-version'
import { followRuns } from './watch'

const SEVERAL = /[,:]/

const usage = `ft release <patch|minor|major|x.y.z>
ft release <level> -p <a,b:minor,...>
ft release <level> --all
ft release --tagged

Cuts a release from the default branch: waits for the runs on HEAD, bumps and tags with \`bun pm version\`, pushes, then waits for the runs and the registry.
Failing tests stop it before anything is bumped or tagged, and a refused or interrupted push drops the bump commits and their tags; with --tagged the commit and tag are yours and stay.
--package releases workspace packages tagged \`<folder>-v<version>\`, each with an optional level of its own (\`-p ft:minor,db\`), --all every published one, in one atomic push.
Once released, an open milestone titled like the version has its closed issues listed and is closed; a failure there only warns.`
const EXITS: ExitRow[] = [[0, 'released or planned'], [1, 'a run fails, origin refuses a push or the registry never serves the version'], [2, 'a timeout, a stalled queue, a refusal before anything ran (another branch, uncommitted changes, origin ahead) or a usage error']]

const options = {
  'tagged': { type: 'boolean', description: 'push the version commit and tag already at HEAD instead of bumping' },
  'package': { type: 'string', short: 'p', description: 'workspace folder to release, a path or a name under packages/, several separated by commas' },
  'all': { type: 'boolean', description: 'release every published package of the workspace in one push' },
  'no-registry': { type: 'boolean', description: 'do not wait for the registry to serve the new version' },
  'dry-run': { type: 'boolean', description: 'print what the release would do, changing nothing' },
  'timeout': { type: 'string', short: 't', description: 'how long to wait for the runs (15m), a bare number in minutes' },
  'json': jsonOption('{released, tag, package, version, status, runs, failedJobs, url} on stdout and the progress on stderr, an array with several packages; not with --dry-run'),
} as const

export type Released = ReturnType<typeof ciJson> & { released: boolean, tag: string, package: string | null, version: string }

// One package of the release once bumped: its tag sits on `head`.
interface Bumped {
  dir: string | undefined
  prefix: string
  tag: string
  head: string
}

export async function release(args: string[]): Promise<number> {
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

  const several = values.all === true || SEVERAL.test(values.package ?? '')

  if (several && (tagged || level === undefined))
    fail('--all and several packages take a level, not --tagged')

  if (values.all === true && values.package !== undefined)
    fail('give --all or --package, not both')

  // Every package is found before anything runs, so a wrong folder stops the release before the tests are waited for.
  const targets = several && level !== undefined
    ? await Promise.all(parseTargets(values.package ?? (await publishable()).join(','), level).map(async target => ({ level: target.level, dir: await packageDir(target.folder) })))
    : [{ level, dir: values.package === undefined ? undefined : await packageDir(values.package) }]

  if (targets.length === 0)
    fail('no package to release: --all found no published package, or --package named none')

  const timeout = duration(values.timeout, 'timeout', 15 * 60_000, 'm')
  const prefixOf = (dir: string | undefined): string => dir === undefined ? 'v' : `${basename(dir)}-v`
  const branch = await defaultBranch()
  const current = await git(['branch', '--show-current'])

  if (current !== branch)
    fail(`a release is cut from ${branch}, not ${current || 'a detached HEAD'}`, 2, runHint(`git switch ${branch}`))

  if (await git(['status', '--porcelain']) !== '')
    fail('the tree has uncommitted changes', 2, runHint('gst', 'see them, then commit them with gc'))

  await fetchBranch(branch)

  // A push origin would refuse is caught before the bump.
  if ((await $`git merge-base --is-ancestor ${`origin/${branch}`} HEAD`.quiet().nothrow()).exitCode !== 0)
    fail(`origin/${branch} has commits HEAD lacks`, 2, runHint(`git pull --rebase origin ${branch}`))

  // With --tagged, HEAD is the version commit and the tests run on the one below it.
  const base = await git(['rev-parse', tagged ? 'HEAD~1' : 'HEAD'])

  if (values['dry-run'] === true)
    return printPlan({ releases: targets.map(({ level, dir }) => ({ level, dir, prefix: prefixOf(dir) })), branch, base, timeout, registry: values['no-registry'] !== true })

  if (!await testsPass(base, branch, timeout, json))
    fail(`the runs on ${base.slice(0, 7)} failed, so nothing was bumped or tagged`, 1, runHint(`ft runs --sha ${base.slice(0, 7)}`, 'list the runs, then ft logs <id> reads the failure'))

  // Read before the bump, so a failure here leaves nothing to undo.
  const preBump = await git(['rev-parse', 'HEAD'])
  const before = (await recentRuns(1))[0]?.id ?? 0
  const held = holdSignals()
  // A getter TypeScript narrows after one check, though a signal can arrive at any await.
  const signalOf = () => held.signal
  const bumped: Bumped[] = []
  let pushed = false
  // a push that timed out may have landed, so its bump is kept rather than dropped
  let isPushUnknown = false

  // Everything between the first bump and the push is undone on a failure or a signal, but only what this run created: with --tagged the commit and tag are the user's own.
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

    // One push for every package, so the branch's runs test the bumps once.
    try {
      push = await pushToOrigin(['--atomic', 'origin', `HEAD:refs/heads/${branch}`, ...tags.map(tag => `refs/tags/${tag}`)], child => held.forward(child))
    }
    catch (error) {
      isPushUnknown = true
      fail(`${error instanceof Error ? error.message : String(error)}, so ${tags.join(', ')} and ${tags.length === 1 ? 'its commit are' : 'their commits are'} kept: the push may have landed`, 2, tags.length === 1 ? `git ls-remote origin refs/tags/${tags[0]} tells; if it is there, ft release --tagged waits for its runs` : `git ls-remote --tags origin tells; if they are there, ft watch --after ${before} waits for their runs`)
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
  let followed: Followed = { code: 0, runs: [], failedJobs: [] }

  // Every package in one result each, those not released yet as false; a package reports the runs its tag started and those of the branch, which test them all.
  const report = (): void => {
    if (!json)
      return

    const results: Released[] = bumped.map((each, index) => {
      const own = followed.runs.filter(run => run.prettyref === each.tag || run.prettyref === branch)

      return { released: released.has(each), tag: each.tag, package: manifests[index]?.name ?? null, version: each.tag.slice(each.prefix.length), ...ciJson(own, followed.failedJobs.filter(job => own.some(run => run.id === job.run))) }
    })

    printJson(several ? results : results[0])
  }

  // From here the tags are out, so a failure still reports the packages not done as not released.
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

          fail(`the runs passed but the registry does not serve ${pkg.name}@${version}${rest.length === 0 ? '' : `, so ${rest.join(', ')} ${rest.length === 1 ? 'is' : 'are'} pushed but not waited for`}: read the publish job with \`ft logs\``, 1)
        }

        say(`released ${pkg.name}@${version}`)
      }
      else {
        say(`released ${each.tag}`)
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
export { commitPackageBump, settleMilestone } from './release-steps'
export { nextVersion, taggedVersion } from './release-version'
