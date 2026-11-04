import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
// Runs `work` over `items` with at most `limit` in flight, keeping the order of the results.
export async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++

      results[index] = await work(items[index] as T)
    }
  }))

  return results
}

const FS_LIMIT = 32
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
export async function sizeOf(folder: string): Promise<number> {
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
