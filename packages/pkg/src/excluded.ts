import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { userConfigPath } from '@kaynooo/cli-kit'

/** The folders left out of a package's bumps, by package name. */
export type Excluded = Record<string, string[]>

/** Where the choice is kept: a file of its own, so a hand-written pkg.json with comments is never rewritten. */
export function excludedPath(home?: string): string {
  return userConfigPath('pkg-excluded', { home })
}

// Undefined when the file is there but does not parse, so a hand-edited one is never written over.
export function loadExcluded(home?: string): Excluded | undefined {
  const path = excludedPath(home)

  if (!existsSync(path))
    return {}

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const excluded: Excluded = {}

    for (const [name, dirs] of Object.entries(raw)) {
      if (Array.isArray(dirs))
        excluded[name] = dirs.filter((dir): dir is string => typeof dir === 'string')
    }

    return excluded
  }
  catch {
    return undefined
  }
}

/** Remembers which folders are left out of `name`'s bumps, the list dropped once it is empty. */
export function saveExcluded(name: string, dirs: readonly string[], home?: string): void {
  const path = excludedPath(home)
  const excluded = loadExcluded(home)

  if (excluded === undefined)
    return

  if (dirs.length === 0)
    delete excluded[name]
  else
    excluded[name] = [...dirs].toSorted()

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(excluded, null, 2)}\n`)
}
