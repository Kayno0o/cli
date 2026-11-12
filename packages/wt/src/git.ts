import type { Worktree } from './project'
import { existsSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { $ } from 'bun'
import { WtError } from './project'

export async function git(cwd: string, ...args: string[]): Promise<{ ok: boolean, out: string }> {
  const result = await $`git -C ${cwd} ${args}`.quiet().nothrow()

  return { ok: result.exitCode === 0, out: `${result.stdout.toString()}${result.stderr.toString()}`.trim() }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  if ((await git(repo, 'show-ref', '--quiet', '--verify', `refs/heads/${branch}`)).ok)
    return true

  return (await git(repo, 'for-each-ref', '--format=%(refname)', `refs/remotes/*/${branch}`)).out !== ''
}

// What a new branch forks from, named as the user knows it: `main (1a2b3c4)`, the ref given, or `a detached HEAD (1a2b3c4)`.
async function forkPoint(repo: string, from: string | undefined): Promise<string | undefined> {
  const sha = await git(repo, 'rev-parse', '--short', `${from ?? 'HEAD'}^{commit}`)

  if (!sha.ok)
    return undefined

  if (from !== undefined)
    return `${from} (${sha.out})`

  const name = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).out

  return name === 'HEAD' ? `a detached HEAD (${sha.out})` : `${name} (${sha.out})`
}

// A branch neither local nor remote is created from `from`, the repo's current HEAD by default; one that exists, a remote one tracked, is checked out as it is. Says which, for the user to see where the work starts.
async function onBranch(repo: string, dir: string, branch: string, from: string | undefined): Promise<{ ok: boolean, out: string, start: string }> {
  if (await branchExists(repo, branch))
    return { ...await git(repo, 'worktree', 'add', dir, branch), start: `on ${branch} as it is` }

  const point = await forkPoint(repo, from)

  if (point === undefined)
    return { ok: false, out: `no commit ${from ?? 'HEAD'} in ${repo}`, start: '' }

  return { ...await git(repo, 'worktree', 'add', '-b', branch, dir, ...from === undefined ? [] : [from]), start: `on ${branch}, forked from ${point}` }
}

// Every repo inside the root checks out the branch; the root does too when it is the only repo, and is detached otherwise, its nested repos holding the work.
/** Checks the worktree out, `from` the ref a new branch forks from; says where each repo starts, the root first. */
export async function addWorktrees(worktree: Worktree, branch: string, from?: string): Promise<string[]> {
  const { project, dir } = worktree

  if (existsSync(dir))
    throw new WtError(`${dir} already exists`, `\`wt sync ${worktree.task} -p ${project.name}\` finishes it, \`wt rm ${worktree.task} -p ${project.name}\` removes it`)

  if (from !== undefined) {
    for (const repo of project.repos.length ? project.repos : ['.']) {
      if (await branchExists(join(project.root, repo), branch))
        throw new WtError(`${branch} already exists${repo === '.' ? '' : ` in ${repo}`}, so it is checked out as it is: drop --from, or name a new branch`)
    }
  }

  mkdirSync(dirname(dir), { recursive: true })

  if (!project.repos.length) {
    const root = await onBranch(project.root, dir, branch, from)

    if (!root.ok)
      throw new WtError(`git worktree add failed for the root:\n${root.out}`)

    return [root.start]
  }

  const root = await git(project.root, 'worktree', 'add', '--detach', dir)

  if (!root.ok)
    throw new WtError(`git worktree add failed for the root:\n${root.out}`)

  const starts: string[] = []

  for (const repo of project.repos) {
    const added = await onBranch(join(project.root, repo), join(dir, repo), branch, from)

    if (!added.ok) {
      await removeWorktrees(worktree)

      throw new WtError(`git worktree add failed for ${repo}, rolled back:\n${added.out}`)
    }

    starts.push(`${repo} ${added.start}`)
  }

  return starts
}

export async function removeWorktrees(worktree: Worktree): Promise<void> {
  const { project, dir } = worktree

  await Promise.all(project.repos.map(async repo => git(join(project.root, repo), 'worktree', 'remove', '--force', join(dir, repo))))
  await git(project.root, 'worktree', 'remove', '--force', dir)

  // Data cloned for the stack belongs to container users, so whatever git could not delete goes through a container.
  if (existsSync(dir))
    await $`docker run --rm -v ${`${dirname(dir)}:/parent`} alpine rm -rf ${`/parent/${basename(dir)}`}`.quiet()

  await Promise.all(['.', ...project.repos].map(async repo => git(join(project.root, repo), 'worktree', 'prune')))

  if (existsSync(dirname(dir)) && !readdirSync(dirname(dir)).length)
    rmdirSync(dirname(dir))
}

export async function dirtyRepos(worktree: Worktree): Promise<string[]> {
  const repos = ['.', ...worktree.project.repos]
  const statuses = await Promise.all(repos.map(async repo => git(join(worktree.dir, repo), 'status', '--porcelain')))

  return repos.filter((_, index) => statuses[index]!.ok && statuses[index]!.out !== '').map(repo => repo === '.' ? 'root' : repo)
}

// How many commits each repo's HEAD has that no branch, remote or tag holds, which removing the checkout would lose; the root is named "root".
async function unreachableByRepo(dir: string, repos: string[]): Promise<{ repo: string, count: number }[]> {
  const all = ['.', ...repos]
  const counts = await Promise.all(all.map(async repo => git(join(dir, repo), 'rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes', '--tags')))

  return all.map((repo, index) => ({ repo: repo === '.' ? 'root' : repo, count: Number(counts[index]!.ok ? counts[index]!.out : 0) })).filter(({ count }) => count > 0)
}

/** The repos whose HEAD has commits no branch, remote or tag holds, which removing the worktree would lose, with how many. */
export async function unreachableCommits(worktree: Worktree): Promise<string[]> {
  return (await unreachableByRepo(worktree.dir, worktree.project.repos)).map(({ repo, count }) => `${repo} (${count} commit${count === 1 ? '' : 's'})`)
}

/** How many commits on no branch a checkout holds, over the root and its repos. */
export async function unreachableCount(dir: string, repos: string[]): Promise<number> {
  return (await unreachableByRepo(dir, repos)).reduce((total, { count }) => total + count, 0)
}

/** Whether git still lists the worktree, its folder gone or not. */
export async function isRegistered(worktree: Worktree): Promise<boolean> {
  const listed = await git(worktree.project.root, 'worktree', 'list', '--porcelain')

  return listed.out.split('\n').includes(`worktree ${worktree.dir}`)
}

export async function currentBranch(dir: string): Promise<string> {
  const result = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')

  return result.ok ? result.out : '?'
}
