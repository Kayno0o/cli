import type { GlobalOptions } from './commands'
import { assertWorktreeExists, listTasks, locate, locateWorktree, worktreeOf } from './project'
import { urlsOf } from './routes'

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

export async function printTasks(options: GlobalOptions): Promise<void> {
  try {
    console.log(listTasks((await locate(process.cwd(), options.project)).project).join('\n'))
  }
  catch {}
}
