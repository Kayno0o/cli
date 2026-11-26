import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { badUsage, formatSize, ignoredFolders, parseSize, runCommand } from '@kaynooo/cli-kit'

// A file past this size is generated or data, never read unless --max-size raises it.
let maxBytes = 2_000_000

export const MAX_SIZE_OPTION = { 'max-size': { type: 'string', description: 'the largest file read, 2000000 bytes by default, a size such as 10M' } } as const

// Sets the size limit of every read after it from `--max-size`; a usage error when it is no size.
export function useMaxSize(value: string | undefined): void {
  if (value === undefined)
    return

  maxBytes = parseSize(value) ?? badUsage(`--max-size takes a size such as 500K or 10M, not '${value}'`)
}
// Bytes looked at for a NUL, the sign of a binary file.
const SNIFF_BYTES = 8000

function walk(dir: string, found: string[], ignored: ReadonlySet<string>): string[] {
  let entries

  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return found
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || ignored.has(entry.name))
      continue

    if (entry.isDirectory())
      walk(join(dir, entry.name), found, ignored)
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

  const ignored = ignoredFolders()

  return roots.flatMap(root => statSync(root, { throwIfNoEntry: false })?.isFile() === true ? [root] : walk(root, [], ignored)).map(path => relative(cwd, path)).sort()
}

// The file's text, undefined for a binary file, one too large or one that cannot be read.
export async function readText(path: string): Promise<string | undefined> {
  const file = Bun.file(path)

  try {
    if (file.size > maxBytes || (await file.slice(0, SNIFF_BYTES).bytes()).includes(0))
      return undefined

    return await file.text()
  }
  catch {
    return undefined
  }
}

// Why the file cannot be read: missing, binary, or too large with its size and the limit.
export async function unreadableReason(path: string): Promise<string> {
  const file = Bun.file(path)

  if (!(await file.exists()))
    return 'missing'

  if (file.size > maxBytes)
    return `${formatSize(file.size)}, over the ${formatSize(maxBytes)} --max-size`

  try {
    return (await file.slice(0, SNIFF_BYTES).bytes()).includes(0) ? 'binary' : 'unreadable'
  }
  catch {
    return 'unreadable'
  }
}
