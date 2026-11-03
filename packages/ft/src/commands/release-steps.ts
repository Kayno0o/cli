import type { Manifest } from './release-version'
import { join, resolve } from 'node:path'
import { fail, isPermanentFailure, runTool, warn } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { git, tagsAt } from '../git'
import { closedIssues, openIssues } from '../issues'
import { closeMilestone, listMilestones } from '../milestones'

const REGISTRY_TRIES = 12
const REGISTRY_POLL = 5000
// How long one `bun info` may take before the registry counts as not serving the version yet.
const REGISTRY_INFO_MS = 30_000

export async function packageDir(value: string): Promise<string> {
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
export async function waitForRegistry(name: string, version: string): Promise<boolean> {
  for (let attempt = 0; attempt < REGISTRY_TRIES; attempt++) {
    let served: string | undefined

    try {
      served = (await runTool('bun info', ['bun', 'info', name, 'version', '--no-cache'], { timeoutMs: REGISTRY_INFO_MS })).stdout.trim().split('\n').at(-1)
    }
    catch (error) {
      if (isPermanentFailure(error))
        throw error
    }

    if (served === version)
      return true

    await Bun.sleep(REGISTRY_POLL)
  }

  return false
}

// Drops the bump commit and the tags it made, back to the commit the release started on; a failure only warns, as the release already failed.
export async function rollBack(preBump: string, tagsBefore: Set<string>): Promise<void> {
  try {
    for (const name of await tagsAt('HEAD')) {
      if (!tagsBefore.has(name))
        await git(['tag', '-d', name])
    }

    await git(['reset', '--keep', preBump])
  }
  catch (error) {
    warn(`could not undo the bump, back to ${preBump.slice(0, 7)} by hand`, error instanceof Error ? error.message : String(error))
  }
}

// Lists the closed issues of the open milestone named like the released version (`1.2.0`, `v1.2.0` or the tag) and closes it; a failure only warns, as the release itself is done.
export async function settleMilestone(version: string, tag: string): Promise<void> {
  try {
    const names = new Set([version, `v${version}`, tag])
    const found = (await listMilestones('open')).find(each => names.has(each.title))

    if (found === undefined)
      return

    const [done, left] = await Promise.all([closedIssues(found.id), openIssues(undefined, undefined, found.id)])

    console.log(`milestone ${found.title}: ${done.length} closed issue${done.length === 1 ? '' : 's'}${done.length === 0 ? '' : `\n${done.map(issue => `  #${issue.number} ${issue.title}`).join('\n')}`}`)

    if (left.length > 0)
      warn(`${left.length} issue${left.length === 1 ? ' is' : 's are'} still open in it`, left.map(issue => `#${issue.number}`).join(' '))

    await closeMilestone(found.id)
    console.log(`closed milestone ${found.title}`)
  }
  catch (error) {
    warn(`released, but the milestone ${version} could not be settled`, error instanceof Error ? error.message : String(error))
  }
}
