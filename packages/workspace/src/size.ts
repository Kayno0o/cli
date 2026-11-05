import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runCommand } from '@kaynooo/cli-kit'

const FS_LIMIT = 32
// A hung mount stops holding a slot after this long and is measured by the walk instead.
const FIND_MS = 60_000
// A file per line as `find` prints it (links, device:inode, bytes), among its complaints about unreadable folders, which share the captured text.
const FIND_LINE = /^(\d+) (\S+) (\d+)$/gm
const waiting: (() => void)[] = []
let running = 0

// Every filesystem call of the size walk goes through here, so the whole process keeps at most FS_LIMIT in flight however deep the folders nest.
async function gated<T>(call: () => Promise<T>): Promise<T> {
  if (running >= FS_LIMIT)
    await new Promise<void>(resolve => waiting.push(resolve))

  running++

  try {
    return await call()
  }
  finally {
    running--
    waiting.shift()?.()
  }
}

// The sum of the file sizes under a folder by lstat, never following a symlink, a file with several hard links counted once.
export async function walkSize(folder: string): Promise<number> {
  const seen = new Set<string>()
  let total = 0
  const visit = async (dir: string): Promise<void> => {
    let entries

    try {
      entries = await gated(async () => readdir(dir, { withFileTypes: true }))
    }
    catch {
      return
    }

    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name)

      if (entry.isDirectory())
        return visit(path)

      try {
        const stat = await gated(async () => lstat(path))

        if (stat.nlink > 1) {
          const key = `${stat.dev}:${stat.ino}`

          if (seen.has(key))
            return

          seen.add(key)
        }

        total += stat.size
      }
      catch {}
    }))
  }

  await visit(folder)

  return total
}

// The sum of the file and symlink sizes of a folder from `find`, the same total as the walk, several times faster than making it here; undefined when find is missing or timed out. Unreadable folders make find exit nonzero yet still print the rest.
async function findSize(folder: string): Promise<number | undefined> {
  try {
    const ran = await runCommand(['find', '-P', folder, '(', '-type', 'f', '-o', '-type', 'l', ')', '-printf', '%n %D:%i %s\\n'], { timeoutMs: FIND_MS })

    if (ran.timedOut)
      return undefined

    const seen = new Set<string>()
    let total = 0

    for (const [, links, id, bytes] of ran.text.matchAll(FIND_LINE)) {
      if (Number(links) > 1) {
        if (seen.has(id!))
          continue

        seen.add(id!)
      }

      total += Number(bytes)
    }

    return total
  }
  catch {
    return undefined
  }
}

// The size of a folder in bytes, by `find` where there is one and by a walk otherwise.
export async function sizeOf(folder: string): Promise<number> {
  return await findSize(folder) ?? await walkSize(folder)
}
