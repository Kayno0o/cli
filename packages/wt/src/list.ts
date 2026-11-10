import type { GlobalOptions } from './commands'
import type { Project } from './project'
import { basename, join } from 'node:path'
import { runningProjects } from './compose'
import { currentBranch, git, unreachableCount } from './git'
import { listTasks, loadProjects, locate, worktreeOf } from './project'
import { urlsOf } from './routes'

export interface Checkout {
  project: string
  task: string
  dir: string
  branch: string
  url: string
  running: boolean
  /** Changed files over the root and its repos. */
  dirty: number
  /** Commits a worktree holds on no branch, which `wt rm --force` would lose; 0 for main, which wt never removes. */
  unbranched: number
  /** The terminal session name of the checkout: its folder's name for main, `<repo>--<task>` for a worktree, as Herdr spaces are named. */
  session: string
}

// A session name holds no "." or ":" (nor a slash or a blank), which a terminal's address reads as separators.
const UNSAFE_IN_SESSION = /[.:\s/]/g
const sessionOf = (name: string) => name.replace(UNSAFE_IN_SESSION, '-')

interface ListOptions extends GlobalOptions {
  all?: boolean
  json?: boolean
}

// The current project, null outside one, and what to list: it alone, or every project when asked to or, for a person, when outside one; JSON outside one lists nothing, the worktrees mod hiding there anyway.
async function projectsToList(options: ListOptions): Promise<{ here: Project | null, projects: Project[] }> {
  let here: Project | null = null

  try {
    here = (await locate(process.cwd(), options.project)).project
  }
  catch {}

  const everywhere = options.all === true || (!here && !options.json)

  return { here, projects: everywhere ? await loadProjects() : [here].filter(project => project !== null) }
}

/** How many files `git status --porcelain` outputs list, over every repo. */
export function changedFiles(outputs: string[]): number {
  return outputs.flatMap(out => out.split('\n')).filter(line => line.trim() !== '').length
}

// Without optional locks, so a commit running in the checkout meanwhile never meets an index.lock this status took
async function dirtyCount(dir: string, repos: string[]): Promise<number> {
  const statuses = await Promise.all(['.', ...repos].map(async repo => git(join(dir, repo), '--no-optional-locks', 'status', '--porcelain')))

  return changedFiles(statuses.filter(status => status.ok).map(status => status.out))
}

async function checkoutsOf(project: Project, running: Set<string>): Promise<Checkout[]> {
  const branchDir = project.repos[0] ?? '.'
  const mainHost = project.routes.find(route => !route.host.startsWith('*.'))?.host
  const main = { id: basename(project.root), task: 'main', dir: project.root, url: mainHost !== undefined ? `https://${mainHost}` : '' }
  const worktrees = listTasks(project).map((task) => {
    const worktree = worktreeOf(project, task)

    return { id: worktree.id, task, dir: worktree.dir, url: urlsOf(worktree)[0] ?? '' }
  })

  return Promise.all([main, ...worktrees].map(async ({ id, task, dir, url }) => ({
    project: project.name,
    task,
    dir,
    branch: await currentBranch(join(dir, branchDir)),
    url,
    running: running.has(id),
    dirty: await dirtyCount(dir, project.repos),
    unbranched: task === 'main' ? 0 : await unreachableCount(dir, project.repos),
    session: sessionOf(task === 'main' ? basename(dir) : id),
  })))
}

// One row per checkout, `*` marking a stack that is up; as JSON, `{ project, checkouts }`, project being the one the directory is in, null outside every one.
export async function listWorktrees(options: ListOptions): Promise<void> {
  const [running, { here, projects }] = await Promise.all([runningProjects(), projectsToList(options)])
  const checkouts = (await Promise.all(projects.map(async project => checkoutsOf(project, running)))).flat()

  if (options.json) {
    console.log(JSON.stringify({ project: here?.name ?? null, checkouts }))

    return
  }

  const rows = checkouts.map(checkout => [checkout.running ? '*' : ' ', checkout.project, checkout.task, checkout.branch, checkout.url, [checkout.dirty ? `${checkout.dirty} changed` : '', checkout.unbranched ? `${checkout.unbranched} on no branch` : ''].filter(Boolean).join(', ')])
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map(row => row[column]!.length))) ?? []

  for (const row of rows)
    console.log(row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd())
}
