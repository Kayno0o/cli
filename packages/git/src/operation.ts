import type { Operation } from './status'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function numberIn(path: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(path, 'utf8'), 10)

    return Number.isNaN(value) ? undefined : value
  }
  catch {
    return undefined
  }
}

// The operation in progress, read from the files git keeps in its git dir.
export function operationOf(gitDir: string): Operation | null {
  const has = (name: string) => existsSync(join(gitDir, name))

  if (has('rebase-merge'))
    return { kind: 'rebase', step: numberIn(join(gitDir, 'rebase-merge/msgnum')), total: numberIn(join(gitDir, 'rebase-merge/end')) }

  if (has('rebase-apply'))
    return { kind: 'rebase', step: numberIn(join(gitDir, 'rebase-apply/next')), total: numberIn(join(gitDir, 'rebase-apply/last')) }

  for (const [file, kind] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']] as const) {
    if (has(file))
      return { kind }
  }

  return null
}
