import type { Worktree } from './project'
import { warn } from '@kaynooo/cli-kit'
import { baseComposeFiles, composeConfig, overrideWarnings, renderOverride, unknownServices } from './compose'
import { cloneData, copyFromMain, linkFromMain, writeEnvFiles, writeIfChanged } from './files'
import { stringToPort } from './port'
import { assertWorktreeExists, listTasks, loadProjects, worktreeOf } from './project'
import { writeStackCerts } from './routes'

// Everything a worktree needs besides its git checkouts. Safe to run again: copies and clones never overwrite, generated files are rewritten.
export async function syncWorktree(worktree: Worktree): Promise<void> {
  assertWorktreeExists(worktree)

  const [warnings, main] = await Promise.all([copyFromMain(worktree), composeConfig(worktree.project.root)])

  warnings.push(...await unknownServices(worktree.project, main))
  linkFromMain(worktree)
  writeEnvFiles(worktree)
  warnings.push(...await cloneData(worktree, main))

  const config = await composeConfig(worktree.dir, { COMPOSE_FILE: baseComposeFiles(worktree.dir, worktree.project.settings.overrides).join(':'), COMPOSE_PROJECT_NAME: worktree.id })

  writeIfChanged(worktree.files.override, renderOverride(worktree, config))
  warnings.push(...overrideWarnings(worktree, config))

  // Read back through the worktree's own .env, so a merge compose rejects fails here rather than on `wt up`.
  await composeConfig(worktree.dir)
  await writeStackCerts(worktree)

  warnings.push(...await portClashes(worktree))

  for (const warning of warnings)
    warn(warning)
}

// Ports are hashed from names, so two may land on one; main's is hashed from its project's name. Whether the port is in use is asked on add only, as the worktree's own dev server holds it once running.
async function portClashes(worktree: Worktree): Promise<string[]> {
  const port = worktree.clientPort
  const sharing: string[] = []

  for (const project of await loadProjects(() => undefined)) {
    if (stringToPort(project.name) === port)
      sharing.push(`${project.name}'s main`)

    for (const task of listTasks(project)) {
      const other = worktreeOf(project, task)

      if (other.id !== worktree.id && other.clientPort === port)
        sharing.push(`${project.name}/${task}`)
    }
  }

  return sharing.length ? [`dev server port ${port} of ${worktree.task} is also the one of ${sharing.join(', ')}: give one of them its own in the manifest's ports`] : []
}
