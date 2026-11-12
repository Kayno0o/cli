import type { Worktree } from './project'
import { existsSync, rmSync } from 'node:fs'
import { $ } from 'bun'
import { knownMessage } from './errors'
import { addWorktrees, dirtyRepos, isRegistered, removeWorktrees, unreachableCommits } from './git'
import { assertWorktreeExists, listTasks, locate, locateWorktree, worktreeOf, WtError } from './project'
import { urlsOf } from './routes'
import { forgetTestDatabases } from './run'
import { afterRemove, hasContainers, stackDown, stackUp } from './stack'
import { syncWorktree } from './sync'

export interface GlobalOptions {
  project?: string
}

const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/
const WHITESPACE = /\s+/

/** The anonymous volumes of the worktree's containers, read before they are removed, as nothing ties those volumes to the worktree afterwards. */
async function anonymousVolumes(worktree: Worktree): Promise<string[]> {
  const containers = (await $`docker ps -aq --filter ${`label=com.docker.compose.project=${worktree.id}`}`.quiet().text()).split('\n').filter(Boolean)

  if (!containers.length)
    return []

  const mounts = await $`docker inspect --format ${'{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}'} ${containers}`.quiet().nothrow()

  return mounts.text().split(WHITESPACE).filter(name => ANONYMOUS_VOLUME.test(name))
}

// Only volumes compose made for the worktree go: a volume with a fixed `name:` may be main's, whatever project created it.
async function removeVolumes(worktree: Worktree, anonymous: string[]): Promise<void> {
  const named = (await $`docker volume ls -q --filter ${`label=com.docker.compose.project=${worktree.id}`}`.quiet().text()).split('\n').filter(volume => volume.startsWith(`${worktree.id}_`))
  const volumes = [...new Set([...named, ...anonymous])]

  if (!volumes.length)
    return

  const removed = await $`docker volume rm ${volumes}`.quiet().nothrow()

  if (removed.exitCode !== 0)
    throw new WtError(`could not remove the volumes of ${worktree.id}:\n${removed.stderr.toString().trim()}`)
}

export async function addTask(task: string, branch: string | undefined, options: GlobalOptions): Promise<void> {
  const { project } = await locate(process.cwd(), options.project)
  const worktree = worktreeOf(project, task)
  const checkout = branch ?? `wt/${task}`

  await addWorktrees(worktree, checkout)

  try {
    await syncWorktree(worktree)
  }
  catch (error) {
    const way = `the worktree is checked out but not ready: \`wt sync ${task} -p ${project.name}\` resumes it, \`wt rm ${task} -p ${project.name}\` removes it`

    const message = knownMessage(error)

    if (message !== undefined)
      throw new WtError(`${message}\n${way}`)

    // A bug keeps its stack trace
    console.error(`wt: ${way}`)

    throw error
  }

  console.log(`wt: created ${worktree.dir} on ${checkout}`)

  for (const url of urlsOf(worktree))
    console.log(`    ${url}`)

  console.log(`    wt up ${task}`)
}

export async function syncTask(task: string | undefined, options: GlobalOptions): Promise<void> {
  const worktree = await locateWorktree(process.cwd(), task, options.project)

  await syncWorktree(worktree)
  console.log(`wt: synced ${worktree.id}`)
}

/** Refuses a removal that would lose uncommitted changes or commits on no branch, unless forced. */
async function refuseLosingWork(worktree: Worktree, force: boolean): Promise<void> {
  if (force || !existsSync(worktree.dir))
    return

  const dirty = await dirtyRepos(worktree)

  if (dirty.length)
    throw new WtError(`uncommitted changes in ${dirty.join(', ')}, commit them or pass --force`)

  const unreachable = await unreachableCommits(worktree)

  if (unreachable.length)
    throw new WtError(`commits on no branch in ${unreachable.join(', ')} would be lost, \`git switch -c <branch>\` there or pass --force`)
}

/** Refuses a removal with nothing to remove, or work it would lose, before it claims a job: a job left recording a worktree never there, or a `--bg` one failing out of sight. */
export async function assertRemovable(task: string, options: GlobalOptions & { force?: boolean }): Promise<void> {
  const worktree = await locateWorktree(process.cwd(), task, options.project)

  if (!existsSync(worktree.dir) && !Object.values(worktree.files).some(file => existsSync(file)) && !await isRegistered(worktree))
    throw new WtError(`no worktree ${worktree.task} of ${worktree.project.name}, nothing removed`)

  await refuseLosingWork(worktree, options.force === true)
}

export async function removeTask(task: string, options: GlobalOptions & { force?: boolean }): Promise<void> {
  const worktree = await locateWorktree(process.cwd(), task, options.project)

  // Every command after this one spawns from the cwd, which may be the directory about to go.
  process.chdir(worktree.project.root)

  const anonymous = await anonymousVolumes(worktree)

  // Again inside the job: the tree may have changed since the check before it
  await refuseLosingWork(worktree, options.force === true)

  // With the folder gone, its containers may still hold its volumes
  if (existsSync(worktree.dir) || await hasContainers(worktree.id))
    await stackDown(worktree)

  await removeVolumes(worktree, anonymous)

  for (const file of Object.values(worktree.files))
    rmSync(file, { force: true })

  await forgetTestDatabases(worktree)

  await removeWorktrees(worktree)
  await afterRemove(worktree)

  console.log(`wt: removed ${worktree.id}, its branches are kept`)
}

export async function printUrls(task: string | undefined, options: GlobalOptions): Promise<void> {
  for (const url of urlsOf(await locateWorktree(process.cwd(), task, options.project)))
    console.log(url)
}

export async function upTask(worktree: Worktree): Promise<void> {
  assertWorktreeExists(worktree)
  await stackUp(worktree)
}

export async function downTask(worktree: Worktree): Promise<void> {
  assertWorktreeExists(worktree)
  await stackDown(worktree)
}

export async function printPath(task: string | undefined, options: GlobalOptions): Promise<void> {
  const { project } = await locate(process.cwd(), options.project)

  if (task === undefined || task === 'main')
    return console.log(project.root)

  const worktree = worktreeOf(project, task)

  assertWorktreeExists(worktree)
  console.log(worktree.dir)
}

export async function printTasks(options: GlobalOptions): Promise<void> {
  try {
    console.log(listTasks((await locate(process.cwd(), options.project)).project).join('\n'))
  }
  catch {}
}
