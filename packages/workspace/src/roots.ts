import { existsSync, statSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { fail, workspaceRoot } from '@kaynooo/cli-kit'

// The folders to scan: each one given, else the configured workspace, each once and each a folder.
export function rootsOf(given: readonly string[], missing: (root: string) => string = root => `no folder ${root}`): string[] {
  const roots = given.length === 0 ? [workspaceRoot()] : [...new Set(given.map(root => workspaceRoot({ given: root })))]

  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory())
      fail(missing(root))
  }

  return roots
}

// What paths are shown relative to: the root itself, or with several the folder holding them all, so two roots never show the same name for different repositories.
export function baseOf(roots: readonly string[]): string {
  let base = roots[0]!

  for (const root of roots.slice(1)) {
    while (root !== base && !root.startsWith(base.endsWith(sep) ? base : base + sep))
      base = dirname(base)
  }

  return base
}

// Runs a scan on each root and joins the paths it found, a path met under two roots kept once.
export async function scanRoots(roots: readonly string[], scan: (root: string, index: number) => Promise<string[]>): Promise<string[]> {
  const found = new Set<string>()

  for (const [index, root] of roots.entries()) {
    for (const path of await scan(root, index))
      found.add(path)
  }

  return [...found]
}
