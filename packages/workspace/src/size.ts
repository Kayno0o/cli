import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

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

// The apparent size of a folder from `du`, about seven times faster than walking it here, the folders' own entries included; undefined when du is missing or says nothing usable. Unreadable files make du exit nonzero yet still print the total of the rest.
async function duSize(folder: string): Promise<number | undefined> {
  try {
    const out = await Bun.$`du -sb -- ${folder}`.quiet().nothrow().text()
    const bytes = Number(out.slice(0, out.indexOf('\t')))

    return out !== '' && Number.isFinite(bytes) ? bytes : undefined
  }
  catch {
    return undefined
  }
}

// The size of a folder in bytes, by `du` where there is one and by a walk otherwise.
export async function sizeOf(folder: string): Promise<number> {
  return await duSize(folder) ?? await walkSize(folder)
}
