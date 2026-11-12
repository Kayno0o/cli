import type { Worktree } from './project'
import { warn } from '@kaynooo/cli-kit'
import { baseComposeFiles, composeConfig, overrideWarnings, renderOverride, unknownServices } from './compose'
import { cloneData, copyFromMain, linkFromMain, writeEnvFiles, writeIfChanged } from './files'
import { assertWorktreeExists } from './project'
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

  for (const warning of warnings)
    warn(warning)
}
