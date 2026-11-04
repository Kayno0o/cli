import type { Entry } from './sweep-scan'
import { existsSync } from 'node:fs'
import { lstat, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runTool } from '@kaynooo/cli-kit'
import { FOLDER_NAMES, isCachePath } from './sweep-scan'

export interface Outcome {
  path: string
  removed: boolean
  error?: string
}

// Only a regular folder bearing one of the listed names is deleted, checked again just before, with rm -rf semantics since the shell's rm may be a trash.
async function removeFolder(entry: Entry): Promise<Outcome> {
  try {
    const stat = await lstat(entry.path)

    if (stat.isSymbolicLink() || !stat.isDirectory() || !(FOLDER_NAMES.has(basename(entry.path)) || (entry.kind === 'cache' && isCachePath(entry.path))))
      return { path: entry.path, removed: false, error: 'no longer a plain folder' }

    if (existsSync(join(entry.path, '.git')))
      return { path: entry.path, removed: false, error: 'holds a git repository' }

    await rm(entry.path, { recursive: true, force: true })

    return { path: entry.path, removed: true }
  }
  catch (error) {
    return { path: entry.path, removed: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Never forced: git refuses a worktree that turned dirty or locked since the scan.
async function removeWorktree(entry: Entry): Promise<Outcome> {
  if (entry.repo === undefined)
    return { path: entry.path, removed: false, error: 'no repository known' }

  try {
    const ran = await runTool('git worktree remove', ['git', '-C', entry.repo, 'worktree', 'remove', entry.path])

    return ran.code === 0 ? { path: entry.path, removed: true } : { path: entry.path, removed: false, error: ran.stderr.trim() }
  }
  catch (error) {
    return { path: entry.path, removed: false, error: String(error) }
  }
}

// Removes the entries one after the other, calling `done` after each; a kept entry is never touched.
export async function applyAll(entries: Entry[], done: (outcome: Outcome) => void): Promise<Outcome[]> {
  const outcomes: Outcome[] = []

  for (const entry of entries) {
    if (entry.action !== 'remove')
      continue

    const outcome = await (entry.kind === 'worktree' ? removeWorktree(entry) : removeFolder(entry))

    outcomes.push(outcome)
    done(outcome)
  }

  return outcomes
}
