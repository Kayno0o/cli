/** What worktrees removed by hand, or an add that crashed, left behind: wt's own files, job records, queues, stacks and volumes no worktree folder answers to. */

import type { GlobalOptions } from './commands'
import type { Project, Worktree } from './project'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { $ } from 'bun'
import { wtConfig } from './config'
import { git } from './git'
import { listTasks, loadProjects, locate, stackName, worktreeOf } from './project'

export interface Orphan {
  worktree: Worktree
  /** What is left of it, in a few words each: "compose override", "2 volumes". */
  left: string[]
}

export interface LeftBehind {
  project: Project
  orphans: Orphan[]
  /** Worktree registrations git keeps for folders gone. */
  stale: number
}

/** What each project, the current one or every one with `all`, has left behind; only the projects with something left. */
export async function leftBehind(options: GlobalOptions & { all?: boolean }): Promise<LeftBehind[]> {
  const projects = options.all ? await loadProjects() : [(await locate(process.cwd(), options.project)).project]
  const { jobs } = await wtConfig()
  const found = await Promise.all(projects.map(async project => ({ project, orphans: await orphansOf(project, jobs), stale: await staleRegistrations(project) })))

  return found.filter(each => each.orphans.length > 0 || each.stale > 0)
}

/** One line per worktree left behind, saying what is left, then git's stale registrations. */
export function describeLeftBehind(found: LeftBehind[]): string[] {
  return found.flatMap(({ project, orphans, stale }) => [
    ...orphans.map(({ worktree, left }) => `${project.name}/${worktree.task}: ${left.join(', ')}`),
    ...stale > 0 ? [`${project.name}: ${stale} git worktree registration${stale === 1 ? '' : 's'} for a folder gone`] : [],
  ])
}

const EXTENSION = /\.[^.]*$/

// What a file of wt's state folder is, by what follows `<id>` in its name.
const STATE_KINDS: [suffix: RegExp, what: string][] = [
  [/^\.setup$/, 'setup marker'],
  [/^\.clones-pending$/, 'pending clones'],
  [/^\.test-/, 'test database marker'],
]

function namesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}

/** The task a name of the project's state starts with, `<prefix><task>` then a dot or, for a volume, an underscore. */
function taskOf(name: string, prefix: string, end: string): string | undefined {
  if (!name.startsWith(prefix))
    return undefined

  const rest = name.slice(prefix.length)
  const stop = rest.indexOf(end)

  return stop > 0 ? rest.slice(0, stop) : undefined
}

async function dockerLines(argv: string[]): Promise<string[]> {
  const listed = await $`docker ${argv}`.quiet().nothrow()

  return listed.exitCode === 0 ? listed.text().split('\n').filter(Boolean) : []
}

/** The worktrees of a project that state still names while no folder holds them, each with what is left of it. */
export async function orphansOf(project: Project, jobsDir: string): Promise<Orphan[]> {
  const live = new Set(listTasks(project))
  const stack = `${stackName(project)}--`
  const left = new Map<string, string[]>()
  const note = (task: string | undefined, what: string | undefined) => {
    if (task !== undefined && what !== undefined && !live.has(task))
      left.set(task, [...left.get(task) ?? [], what])
  }
  const { overrides, state } = project.settings

  for (const name of namesIn(overrides))
    note(taskOf(name, stack, '.override.yml'), 'compose override')

  for (const name of namesIn(state)) {
    const task = taskOf(name, stack, '.')

    note(task, STATE_KINDS.find(([suffix]) => suffix.test(name.slice(stack.length + (task?.length ?? 0))))?.[1])
  }

  for (const name of namesIn(join(state, 'queues')))
    note(taskOf(name, stack, '.'), 'queue')

  // A job's json, log and lock are one record
  for (const name of new Set(namesIn(jobsDir).map(name => name.replace(EXTENSION, ''))))
    note(taskOf(`${name}.`, `${project.name}--`, '.'), 'job record')

  for (const volume of await dockerLines(['volume', 'ls', '-q']))
    note(taskOf(volume, stack, '_'), 'volume')

  for (const label of await dockerLines(['ps', '-a', '--format', '{{.Label "com.docker.compose.project"}}']))
    note(label.startsWith(stack) ? label.slice(stack.length) : undefined, 'container')

  const orphans: Orphan[] = []

  for (const [task, what] of [...left].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      orphans.push({ worktree: worktreeOf(project, task), left: counted(what) })
    }
    // Not a name wt could have made, so not one of its worktrees
    catch {}
  }

  return orphans
}

/** Each kind once in the order first seen, a repeated one counted: "2 volumes". */
function counted(what: string[]): string[] {
  const counts = new Map<string, number>()

  for (const each of what)
    counts.set(each, (counts.get(each) ?? 0) + 1)

  return [...counts].map(([each, count]) => count === 1 ? each : `${count} ${each}s`)
}

/** The worktree registrations git keeps for folders gone, which `git worktree prune` drops, over the root and its repos. */
export async function staleRegistrations(project: Project): Promise<number> {
  const runs = await Promise.all(['.', ...project.repos].map(async repo => git(join(project.root, repo), 'worktree', 'prune', '--dry-run', '--verbose')))

  return runs.filter(run => run.ok).flatMap(run => run.out.split('\n').filter(Boolean)).length
}

export async function pruneRegistrations(project: Project): Promise<void> {
  await Promise.all(['.', ...project.repos].map(async repo => git(join(project.root, repo), 'worktree', 'prune')))
}

/** The queues a worktree's runs lined up in. */
export function removeQueues(worktree: Worktree): void {
  const queues = join(worktree.project.settings.state, 'queues')

  for (const name of namesIn(queues).filter(each => each.startsWith(`${worktree.id}.`)))
    rmSync(join(queues, name), { recursive: true, force: true })
}
