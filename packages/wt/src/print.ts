import type { GlobalOptions } from './commands'
import type { Jobs } from './jobs'
import type { Worktree } from './project'
import { existsSync, readFileSync } from 'node:fs'
import { openUrl } from '@kaynooo/cli-kit'
import { assertWorktreeExists, listTasks, locate, locateWorktree, worktreeOf, WtError } from './project'
import { urlsOf } from './routes'
import { slugOf } from './stack'

/** Prints the log of the worktree's last --bg job: a job run in a terminal printed there and kept none, which a note says when it came after. */
export function printJobLog(worktree: Worktree, jobs: Jobs): void {
  const ref = `${worktree.project.name}/${worktree.task}`
  const slug = slugOf(ref)
  const { log } = jobs.paths(slug)

  if (!existsSync(log))
    throw new WtError(`no job of ${ref} ran with --bg, which alone keeps a log`)

  const state = jobs.states().get(slug) ?? {}
  const latest = state.running ?? state.last

  if (latest !== undefined && latest.log === '')
    console.error(`wt: the last job (${jobs.summary(state)}) ran in a terminal; this log is of the last --bg one`)

  process.stdout.write(readFileSync(log))
}

export async function printUrls(task: string | undefined, options: GlobalOptions): Promise<void> {
  for (const url of urlsOf(await locateWorktree(process.cwd(), task, options.project)))
    console.log(url)
}

export async function printPath(task: string | undefined, options: GlobalOptions): Promise<void> {
  const { project } = await locate(process.cwd(), options.project)

  if (task === undefined || task === 'main')
    return console.log(project.root)

  const worktree = worktreeOf(project, task)

  assertWorktreeExists(worktree)
  console.log(worktree.dir)
}

/** Opens a worktree's main URL in the browser, main's when the task is `main` or the current directory is main's checkout. */
export async function openTask(task: string | undefined, options: GlobalOptions): Promise<void> {
  const here = await locate(process.cwd(), options.project)
  const name = task ?? here.task
  let url: string | undefined

  if (name === 'main') {
    const host = here.project.routes.find(route => !route.host.startsWith('*.'))?.host

    url = host === undefined ? undefined : `https://${host}`
  }
  else {
    const worktree = worktreeOf(here.project, name)

    assertWorktreeExists(worktree)
    url = urlsOf(worktree)[0]
  }

  if (url === undefined)
    throw new WtError(`${here.project.name} routes no host, so ${name} has no URL to open`)

  if (!openUrl(url))
    throw new WtError(`no browser could be started for ${url}`)

  console.log(`wt: opened ${url}`)
}

export async function printTasks(options: GlobalOptions): Promise<void> {
  try {
    console.log(listTasks((await locate(process.cwd(), options.project)).project).join('\n'))
  }
  catch {}
}
