import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateHome, userConfigPath } from '@kaynooo/cli-kit'

/** The folders left out of a package's bumps, by package name. */
export type Excluded = Record<string, string[]>

/** Where the choice is kept: under XDG state (`~/.local/state/kaynooo-cli/pkg-excluded.json`), since it is mutable UI state rather than hand-written config. */
export function excludedPath(home?: string): string {
  const base = home === undefined ? stateHome() : join(home, '.local', 'state')

  return join(base, 'kaynooo-cli', 'pkg-excluded.json')
}

function readExcludedFile(path: string): Excluded | undefined {
  try {
    const raw = Bun.JSONC.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      return undefined

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

// Undefined when the file is there but does not parse, so a hand-edited one is never written over; falls back to the legacy config path while the state file does not exist.
export function loadExcluded(home?: string): Excluded | undefined {
  const path = excludedPath(home)

  if (existsSync(path))
    return readExcludedFile(path)

  const legacy = userConfigPath('pkg-excluded', { home })

  return existsSync(legacy) ? readExcludedFile(legacy) : {}
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
