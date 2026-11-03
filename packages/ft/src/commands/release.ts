import type { Manifest } from './release-version'
import { basename, join } from 'node:path'
import { duration, exitCodeOf, fail, holdSignals, parse, runHint, runTool } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { defaultBranch, fetchBranch, git, tagsAt } from '../git'
import { recentRuns } from '../runs'
import { limits, NO_RUN, testsPass } from './release-checks'
import { parseTargets, publishable } from './release-many'
import { printPlan } from './release-plan'
import { commitPackageBump, packageDir, rollBack, settleMilestone, waitForRegistry } from './release-steps'
import { LEVELS, taggedVersion, VERSION } from './release-version'
import { watchRuns } from './watch'

const SEVERAL = /[,:]/

const usage = `ft release <patch|minor|major|x.y.z>
ft release <level> -p <a,b:minor,...>
ft release <level> --all
ft release --tagged

Cuts a release from the default branch: first the commit it sits on is pushed and its runs waited for, so failing tests stop it before anything is bumped or tagged. Then \`bun pm version\` commits and tags the bump, one atomic push sends the branch and its tag, and it waits for the runs the push started and for the registry to serve the version.
--tagged releases a version commit already tagged at HEAD instead, for repos bumping with their own script; the runs waited for first are then those of the commit below it.
--package releases one workspace package of a monorepo on its own, tagged \`<folder>-v<version>\` (\`ft release patch -p ft\` tags packages/ft as ft-v0.3.0).
--package takes several folders separated by commas, each optionally with its own level after a colon (\`-p ft:minor,db\` bumps ft by minor and db by the level given); --all takes every published package of the workspace. They are released one after the other and the run stops at the first one that fails, naming the ones not released.
A refused or interrupted push drops the bump commit and its tag, so a retry starts clean; with --tagged the commit and tag are yours and stay.
Once released, an open milestone titled like the version (\`1.2.0\`, \`v1.2.0\` or the tag) has its closed issues listed and is closed; a failure there only warns.
--dry-run checks the same and prints the plan: the version bump, the tag, the pushes and the runs and registry it would wait for, changing nothing.
Exits 0 once released or planned, 1 when a run fails, origin refuses a push or the registry never serves the version, 2 on a timeout, a stalled queue, a refusal before anything ran (another branch, uncommitted changes, origin ahead) or a usage error.`

const options = {
  'tagged': { type: 'boolean', description: 'push the version commit and tag already at HEAD instead of bumping' },
  'package': { type: 'string', short: 'p', description: 'workspace folder to release, a path or a name under packages/, several separated by commas' },
  'all': { type: 'boolean', description: 'release every published package of the workspace, one after the other' },
  'no-registry': { type: 'boolean', description: 'do not wait for the registry to serve the new version' },
  'dry-run': { type: 'boolean', description: 'print what the release would do, changing nothing' },
  'timeout': { type: 'string', short: 't', description: 'how long to wait for the runs (15m), a bare number in minutes' },
} as const

export async function release(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values, positionals } = parsed
  const level = positionals[0]
  const tagged = values.tagged === true

  if (tagged === (level !== undefined))
    fail(`give a level or --tagged\n\n${usage}`)

  if (level !== undefined && !LEVELS.has(level) && !VERSION.test(level))
    fail(`${level} is no level nor x.y.z version`)

  if (values.all === true || SEVERAL.test(values.package ?? '')) {
    if (tagged || level === undefined)
      fail('--all and several packages take a level, not --tagged')

    if (values.all === true && values.package !== undefined)
      fail('give --all or --package, not both')

    const targets = parseTargets(values.package ?? (await publishable()).join(','), level)
    const flags = [...values['dry-run'] === true ? ['--dry-run'] : [], ...values['no-registry'] === true ? ['--no-registry'] : [], ...values.timeout === undefined ? [] : ['--timeout', values.timeout]]

    for (const [index, target] of targets.entries()) {
      console.log(`== ${target.level} ${target.folder} (${index + 1}/${targets.length})`)

      const stopped = (): void => console.error(`stopped at ${target.folder}, not released: ${targets.slice(index).map(each => each.folder).join(', ')}`)

      try {
        const code = await release([target.level, '--package', target.folder, ...flags])

        if (code === 0)
          continue

        stopped()

        return code
      }
      catch (error) {
        stopped()

        throw error
      }
    }

    return 0
  }

  const timeout = duration(values.timeout, 'timeout', 15 * 60_000, 'm')
  const dir = values.package === undefined ? undefined : await packageDir(values.package)
  const prefix = dir === undefined ? 'v' : `${basename(dir)}-v`
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
    return printPlan({ level, dir, prefix, branch, base, timeout, registry: values['no-registry'] !== true })

  if (!await testsPass(base, branch, timeout))
    fail(`the runs on ${base.slice(0, 7)} failed, so nothing was bumped or tagged`, 1, runHint(`ft runs --sha ${base.slice(0, 7)}`, 'list the runs, then ft logs <id> reads the failure'))

  // Read before the bump, so a failure here leaves nothing to undo.
  const preBump = await git(['rev-parse', 'HEAD'])
  const tagsBefore = new Set(await tagsAt('HEAD'))
  const before = (await recentRuns(1))[0]?.id ?? 0
  const held = holdSignals()
  // A getter TypeScript narrows after one check, though a signal can arrive at any await.
  const signalOf = () => held.signal
  let tag = ''
  let head = ''
  let pushed = false
  // a push that timed out may have landed, so its bump is kept rather than dropped
  let isPushUnknown = false

  // Everything between the bump and the push is undone on a failure or a signal, but only what this run created: with --tagged the commit and tag are the user's own.
  try {
    if (level !== undefined) {
      const bump = dir === undefined
        ? await $`bun pm version ${level}`.quiet().nothrow()
        : await $`bun pm version ${level} --no-git-tag-version`.cwd(dir).quiet().nothrow()

      if (bump.exitCode !== 0)
        fail(`bun pm version ${level}: ${bump.stderr.toString().trim() || bump.stdout.toString().trim()}`)

      if (dir !== undefined)
        await commitPackageBump(dir, prefix)
    }

    const found = (await tagsAt('HEAD')).find(name => taggedVersion(name, prefix) !== undefined)

    if (found === undefined)
      fail(tagged ? `HEAD carries no ${prefix}* tag` : `the bump made no ${prefix}* tag`)

    tag = found

    head = await git(['rev-parse', 'HEAD'])

    if (held.signal !== undefined)
      fail(`interrupted by ${held.signal} before the push`, exitCodeOf(null, held.signal))

    let push

    try {
      push = await runTool('git push', ['git', 'push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, tag], { timeoutMs: limits.pushMs, onStart: child => held.forward(child) })
    }
    catch (error) {
      isPushUnknown = true
      fail(`${error instanceof Error ? error.message : String(error)}, so ${tag} and its commit are kept: the push may have landed`, 2, `git ls-remote origin refs/tags/${tag} tells; if it is there, ft release --tagged waits for its runs`)
    }

    if (push.code !== 0) {
      const signal = signalOf()

      fail(`origin refused the push${signal === undefined ? '' : `, or ${signal} interrupted it`}, so ${level === undefined ? `${tag} and its commit are kept for a retry` : `${tag} and its commit were dropped for a clean retry`}:\n${push.stderr.trim()}`, signal === undefined ? 1 : exitCodeOf(null, signal))
    }

    pushed = true
  }
  finally {
    held.release()

    if (!pushed && !isPushUnknown && level !== undefined)
      await rollBack(preBump, tagsBefore)
  }

  const late = signalOf()

  if (late !== undefined)
    fail(`interrupted by ${late} after ${tag} was pushed: its runs are not waited for`, exitCodeOf(null, late))

  console.log(`pushed ${branch} and ${tag}, waiting for their runs`)

  const code = await watchRuns(runs => runs.filter(run => run.id > before && run.commit_sha === head), timeout, undefined, NO_RUN)

  if (code !== 0)
    return code

  const file = Bun.file(join(dir ?? '.', 'package.json'))
  const pkg = await file.exists() ? await file.json() as Manifest : undefined
  const version = tag.slice(prefix.length)

  if (values['no-registry'] === true || pkg?.name === undefined || pkg.private === true) {
    console.log(`released ${tag}`)
    await settleMilestone(version, tag)

    return 0
  }

  if (!await waitForRegistry(pkg.name, version))
    fail(`the runs passed but the registry does not serve ${pkg.name}@${version}: read the publish job with \`ft logs\``, 1)

  console.log(`released ${pkg.name}@${version}`)
  await settleMilestone(version, tag)

  return 0
}

export { limits, testsPass } from './release-checks'
export { commitPackageBump, settleMilestone } from './release-steps'
export { nextVersion, taggedVersion } from './release-version'
