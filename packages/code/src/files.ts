import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { runCommand, SKIPPED_FOLDERS } from '@kaynooo/cli-kit'

// A file past this size is generated or data, never read.
const MAX_BYTES = 2_000_000
// Bytes looked at for a NUL, the sign of a binary file.
const SNIFF_BYTES = 8000
// Folders a walk outside git never enters.
const SKIPPED = SKIPPED_FOLDERS

function walk(dir: string, found: string[]): string[] {
  let entries

  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return found
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIPPED.has(entry.name))
      continue

    if (entry.isDirectory())
      walk(join(dir, entry.name), found)
    else if (entry.isFile())
      found.push(join(dir, entry.name))
  }

  return found
}

// The files under the paths (the folder itself when none is given), relative to it: git's own list in a repository, so .gitignore holds, else a walk leaving dependency, build and dot folders out.
export async function listFiles(paths: readonly string[], cwd: string): Promise<string[]> {
  const listed = await runCommand(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths], { cwd })

  if (listed.code === 0)
    return [...new Set(listed.text.split('\0'))].filter(path => path !== '' && existsSync(join(cwd, path))).sort()

  const roots = paths.length === 0 ? [cwd] : paths.map(path => join(cwd, path))

  return roots.flatMap(root => statSync(root, { throwIfNoEntry: false })?.isFile() === true ? [root] : walk(root, [])).map(path => relative(cwd, path)).sort()
}

// The file's text, undefined for a binary file, one too large or one that cannot be read.
export async function readText(path: string): Promise<string | undefined> {
  const file = Bun.file(path)

  try {
    if (file.size > MAX_BYTES || (await file.slice(0, SNIFF_BYTES).bytes()).includes(0))
      return undefined

    return await file.text()
  }
  catch {
    return undefined
  }
}
