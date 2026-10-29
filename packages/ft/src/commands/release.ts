import { $ } from 'bun'
import { fail, parse, wholeNumber } from '../args'
import { defaultBranch, git, tagsAt } from '../git'
import { recentRuns } from '../runs'
import { watchRuns } from './watch'

const usage = `ft release <patch|minor|major|x.y.z>
ft release --tagged

Cuts a release from the default branch: \`bun pm version\` commits and tags the bump, one atomic push sends the branch, with any commits origin lacks, and its tag, then it waits for the runs the push started and for the registry to serve the version.
--tagged releases a version commit already tagged at HEAD instead, for repos bumping with their own script.
A refused push drops the bump commit and its tag, so a retry starts clean.`

const options = {
  'tagged': { type: 'boolean', description: 'push the version commit and tag already at HEAD instead of bumping' },
  'no-registry': { type: 'boolean', description: 'do not wait for the registry to serve the new version' },
  'timeout': { type: 'string', short: 't', description: 'minutes to wait for the runs (15)' },
} as const

const LEVELS = new Set(['patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'prerelease'])
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const VERSION_TAG = /^v\d/
const REGISTRY_TRIES = 12
const REGISTRY_POLL = 5000

interface Manifest { name?: string, version?: string, private?: boolean }

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

export async function release(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  if (parsed === undefined)
    return 0

  const { values, positionals } = parsed
  const level = positionals[0]
  const tagged = values.tagged === true

  if (tagged === (level !== undefined))
    fail(`give a level or --tagged\n\n${usage}`)

  if (level !== undefined && !LEVELS.has(level) && !VERSION.test(level))
    fail(`${level} is no level nor x.y.z version`)

  const timeout = wholeNumber(values.timeout, 'timeout', 15)
  const branch = await defaultBranch()
  const current = await git(['branch', '--show-current'])

  if (current !== branch)
    fail(`a release is cut from ${branch}, not ${current || 'a detached HEAD'}`)

  if (await git(['status', '--porcelain']) !== '')
    fail('the tree has uncommitted changes: commit or stash them first')

  await git(['fetch', '-q', 'origin', branch])

  // Unpushed commits ride along, the tag workflow testing them before it publishes; a push origin would refuse is caught before the bump.
  if ((await $`git merge-base --is-ancestor ${`origin/${branch}`} HEAD`.quiet().nothrow()).exitCode !== 0)
    fail(`origin/${branch} has commits HEAD lacks: pull first`)

  if (level !== undefined) {
    const bump = await $`bun pm version ${level}`.quiet().nothrow()

    if (bump.exitCode !== 0)
      fail(`bun pm version ${level}: ${bump.stderr.toString().trim() || bump.stdout.toString().trim()}`)
  }

  const tag = (await tagsAt('HEAD')).find(name => VERSION_TAG.test(name))

  if (tag === undefined)
    fail(tagged ? 'HEAD carries no v* tag' : 'bun pm version made no v* tag')

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

  const file = Bun.file('package.json')
  const pkg = await file.exists() ? await file.json() as Manifest : undefined
  const version = tag.slice(1)

  if (values['no-registry'] === true || pkg?.name === undefined || pkg.private === true) {
    console.log(`released ${tag}`)

    return 0
  }

  if (!await waitForRegistry(pkg.name, version))
    fail(`the runs passed but the registry does not serve ${pkg.name}@${version}: read the publish job with \`ft logs\``, 1)

  console.log(`released ${pkg.name}@${version}`)

  return 0
}
