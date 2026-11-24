import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { extname, join } from 'node:path'
import { ignoredFolders, runCommand } from '@kaynooo/cli-kit'

export interface WalkFilter {
  globs?: string[]
  exts?: string[]
  excludes?: string[]
}

const LEADING_DOT = /^\./

function matchesFilter(path: string, filter: WalkFilter | undefined): boolean {
  if (filter === undefined)
    return true

  if (filter.exts !== undefined && filter.exts.length > 0) {
    const ext = extname(path).replace(LEADING_DOT, '').toLowerCase()

    if (!filter.exts.includes(ext))
      return false
  }

  if (filter.globs !== undefined && filter.globs.length > 0) {
    if (!filter.globs.some(pattern => new Bun.Glob(pattern).match(path)))
      return false
  }

  if (filter.excludes !== undefined && filter.excludes.length > 0) {
    if (filter.excludes.some(pattern => new Bun.Glob(pattern).match(path)))
      return false
  }

  return true
}

// Bytes looked at for a NUL, the sign of a binary file.
const SNIFF_BYTES = 8000

function isBinary(path: string): boolean {
  try {
    const fd = openSync(path, 'r')

    try {
      const buffer = Buffer.alloc(SNIFF_BYTES)

      return buffer.subarray(0, readSync(fd, buffer, 0, SNIFF_BYTES, 0)).includes(0)
    }
    finally {
      closeSync(fd)
    }
  }
  catch {
    return true
  }
}

function walk(dir: string, found: string[], ignored: ReadonlySet<string>): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ignored.has(entry.name))
      continue

    if (entry.isDirectory())
      walk(join(dir, entry.name), found, ignored)
    else if (entry.isFile())
      found.push(join(dir, entry.name))
  }

  return found
}

// The text files under a folder: git's own list in a repository, so .gitignore holds, else a walk leaving dependency, build and dot folders out. Paths come back as the folder spells them.
export async function filesIn(dir: string, filter?: WalkFilter): Promise<string[]> {
  const listed = await runCommand(['git', '--literal-pathspecs', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', dir])
  const paths = listed.code === 0 ? [...new Set(listed.text.split('\0'))].filter(path => path !== '' && existsSync(path)) : walk(dir, [], ignoredFolders())

  return paths.filter(path => matchesFilter(path, filter) && !isBinary(path)).sort()
}
