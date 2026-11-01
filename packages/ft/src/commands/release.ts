import { basename, join, resolve } from 'node:path'
import { duration, fail, parse } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { defaultBranch, git, gitOk, tagsAt } from '../git'
import { newestPerWorkflow, recentRuns } from '../runs'
import { watchRuns } from './watch'

const usage = `ft release <patch|minor|major|x.y.z>
ft release --tagged

Cuts a release from the default branch: first the commit it sits on is pushed and its runs waited for, so failing tests stop it before anything is bumped or tagged. Then \`bun pm version\` commits and tags the bump, one atomic push sends the branch and its tag, and it waits for the runs the push started and for the registry to serve the version.
--tagged releases a version commit already tagged at HEAD instead, for repos bumping with their own script; the runs waited for first are then those of the commit below it.
--package releases one workspace package of a monorepo on its own, tagged \`<folder>-v<version>\` (\`ft release patch -p ft\` tags packages/ft as ft-v0.3.0).
A refused push drops the bump commit and its tag, so a retry starts clean.`

const options = {
  'tagged': { type: 'boolean', description: 'push the version commit and tag already at HEAD instead of bumping' },
  'package': { type: 'string', short: 'p', description: 'workspace folder to release, a path or a name under packages/' },
  'no-registry': { type: 'boolean', description: 'do not wait for the registry to serve the new version' },
  'timeout': { type: 'string', short: 't', description: 'how long to wait for the runs (15m), a bare number in minutes' },
} as const

const LEVELS = new Set(['patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'prerelease'])
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const REGISTRY_TRIES = 12
const REGISTRY_POLL = 5000
// How long a pushed commit may go without a run before the release goes on: a push touching only ignored paths starts none.
const NO_RUN = 3 * 60_000

interface Manifest { name?: string, version?: string, private?: boolean }

// The version a release tag carries, undefined for any other tag: `v1.2.0` with prefix `v`, `ft-v1.2.0` with `ft-v`.
export function taggedVersion(tag: string, prefix: string): string | undefined {
  const version = tag.slice(prefix.length)

  return tag.startsWith(prefix) && VERSION.test(version) ? version : undefined
}

async function packageDir(value: string): Promise<string> {
  for (const dir of [resolve(value), join(await git(['rev-parse', '--show-toplevel']), 'packages', value)]) {
    if (await Bun.file(join(dir, 'package.json')).exists())
      return dir
  }

  fail(`no package.json in ${value} nor in packages/${value}`)
}

// Commits and tags a package's bump with the lockfile refreshed, since `bun install --frozen-lockfile` refuses a workspace version it does not list.
export async function commitPackageBump(dir: string, prefix: string): Promise<void> {
  const { version } = await Bun.file(join(dir, 'package.json')).json() as Manifest
  const root = await git(['rev-parse', '--show-toplevel'])
  const tag = `${prefix}${version}`
  const lock = await $`bun install --lockfile-only`.cwd(root).quiet().nothrow()

  if (lock.exitCode !== 0)
    fail(`bun install --lockfile-only after the bump: ${lock.stderr.toString().trim()}`)

  await git(['add', join(dir, 'package.json'), join(root, 'bun.lock')])
  await git(['commit', '-q', '-m', tag])
  await git(['tag', '-a', tag, '-m', tag])
}

// The registry serves a version a short while after the publish job ends; --no-cache skips a manifest bun cached before it.
async function waitForRegistry(name: string, version: string): Promise<boolean> {
  for (let attempt = 0; attempt < REGISTRY_TRIES; attempt++) {
    const served = (await $`bun info ${name} version --no-cache`.quiet().nothrow().text()).trim().split('\n').at(-1)

    if (served === version)
      return true

    await Bun.sleep(REGISTRY_POLL)
  }

  return false
}

// Pushes the commit a release sits on when origin lacks it and waits for its own runs, so a red run stops the release before a tag exists that would never publish.
async function testsPass(sha: string, branch: string, timeout: number): Promise<boolean> {
  if (!await gitOk(['merge-base', '--is-ancestor', sha, `origin/${branch}`])) {
    const push = await $`git push origin ${`${sha}:refs/heads/${branch}`}`.quiet().nothrow()

    if (push.exitCode !== 0)
      fail(`origin refused the push of ${sha.slice(0, 7)}, so nothing was bumped:\n${push.stderr.toString().trim()}`, 1)

    console.log(`pushed ${branch} at ${sha.slice(0, 7)}, waiting for its runs before the bump`)
  }

  return await watchRuns(runs => newestPerWorkflow(runs.filter(run => run.commit_sha === sha)), timeout, undefined, NO_RUN) === 0
}

export async function release(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const { values, positionals } = parsed
  const level = positionals[0]
  const tagged = values.tagged === true

  if (tagged === (level !== undefined))
    fail(`give a level or --tagged\n\n${usage}`)

  if (level !== undefined && !LEVELS.has(level) && !VERSION.test(level))
    fail(`${level} is no level nor x.y.z version`)

  const timeout = duration(values.timeout, 'timeout', 15 * 60_000, 'm')
  const dir = values.package === undefined ? undefined : await packageDir(values.package)
  const prefix = dir === undefined ? 'v' : `${basename(dir)}-v`
  const branch = await defaultBranch()
  const current = await git(['branch', '--show-current'])

  if (current !== branch)
    fail(`a release is cut from ${branch}, not ${current || 'a detached HEAD'}`)

  if (await git(['status', '--porcelain']) !== '')
    fail('the tree has uncommitted changes: commit or stash them first')

  await git(['fetch', '-q', 'origin', branch])

  // A push origin would refuse is caught before the bump.
  if ((await $`git merge-base --is-ancestor ${`origin/${branch}`} HEAD`.quiet().nothrow()).exitCode !== 0)
    fail(`origin/${branch} has commits HEAD lacks: pull first`)

  // With --tagged, HEAD is the version commit and the tests run on the one below it.
  const base = await git(['rev-parse', tagged ? 'HEAD~1' : 'HEAD'])

  if (!await testsPass(base, branch, timeout))
    fail(`the runs on ${base.slice(0, 7)} failed, so nothing was bumped or tagged: fix them and release again`, 1)

  if (level !== undefined) {
    const bump = dir === undefined
      ? await $`bun pm version ${level}`.quiet().nothrow()
      : await $`bun pm version ${level} --no-git-tag-version`.cwd(dir).quiet().nothrow()

    if (bump.exitCode !== 0)
      fail(`bun pm version ${level}: ${bump.stderr.toString().trim() || bump.stdout.toString().trim()}`)

    if (dir !== undefined)
      await commitPackageBump(dir, prefix)
  }

  const tag = (await tagsAt('HEAD')).find(name => taggedVersion(name, prefix) !== undefined)

  if (tag === undefined)
    fail(tagged ? `HEAD carries no ${prefix}* tag` : `the bump made no ${prefix}* tag`)

  const before = (await recentRuns(1))[0]?.id ?? 0
  const push = await $`git push --atomic origin ${`HEAD:refs/heads/${branch}`} ${tag}`.quiet().nothrow()

  if (push.exitCode !== 0) {
    await git(['tag', '-d', tag])
    await git(['reset', '--keep', 'HEAD~1'])
    fail(`origin refused the push, so ${tag} and its commit were dropped for a clean retry:\n${push.stderr.toString().trim()}`, 1)
  }

  console.log(`pushed ${branch} and ${tag}, waiting for their runs`)

  const code = await watchRuns(runs => runs.filter(run => run.id > before), timeout)

  if (code !== 0)
    return code

  const file = Bun.file(join(dir ?? '.', 'package.json'))
  const pkg = await file.exists() ? await file.json() as Manifest : undefined
  const version = tag.slice(prefix.length)

  if (values['no-registry'] === true || pkg?.name === undefined || pkg.private === true) {
    console.log(`released ${tag}`)

    return 0
  }

  if (!await waitForRegistry(pkg.name, version))
    fail(`the runs passed but the registry does not serve ${pkg.name}@${version}: read the publish job with \`ft logs\``, 1)

  console.log(`released ${pkg.name}@${version}`)

  return 0
}
