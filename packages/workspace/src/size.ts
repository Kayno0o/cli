import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runCommand } from '@kaynooo/cli-kit'

const FS_LIMIT = 32
// A hung mount stops holding a slot after this long and is measured by the walk instead.
const FIND_MS = 60_000
// An entry per line as `find` prints it (type, links, device:inode, bytes, owner uid), among its complaints about unreadable folders, which share the captured text.
const FIND_LINE = /^(\w) (\d+) (\S+) (\d+) (\d+)$/gm
const OWN_UID = process.getuid?.() ?? -1

export interface Measure {
  bytes: number
  // Entries owned by another user, which deleting as this user would fail on: what a container running as root wrote.
  foreign: number
}
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
  return (await walk(folder, OWN_UID)).bytes
}

async function walk(folder: string, uid: number): Promise<Measure> {
  const seen = new Set<string>()
  let total = 0
  let foreign = 0
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

      try {
        const stat = await gated(async () => lstat(path))

        if (stat.uid !== uid)
          foreign++

        if (entry.isDirectory())
          return await visit(path)

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

  try {
    if ((await lstat(folder)).uid !== uid)
      foreign++
  }
  catch {}

  await visit(folder)

  return { bytes: total, foreign }
}

// The sum of the file and symlink sizes of a folder from `find`, the same total as the walk, several times faster than making it here; undefined when find is missing or timed out. Unreadable folders make find exit nonzero yet still print the rest.
async function findSize(folder: string, uid: number): Promise<Measure | undefined> {
  try {
    const ran = await runCommand(['find', '-P', folder, '-printf', '%y %n %D:%i %s %U\\n'], { timeoutMs: FIND_MS })

    const lines = [...ran.text.matchAll(FIND_LINE)]

    // A find without -printf, as busybox's, prints nothing and fails; that is no size.
    if (ran.timedOut || (ran.code !== 0 && lines.length === 0))
      return undefined

    const seen = new Set<string>()
    let total = 0
    let foreign = 0

    for (const [, type, links, id, bytes, owner] of lines) {
      if (Number(owner) !== uid)
        foreign++

      if (type !== 'f' && type !== 'l')
        continue

      if (Number(links) > 1) {
        if (seen.has(id!))
          continue

        seen.add(id!)
      }

      total += Number(bytes)
    }

    return { bytes: total, foreign }
  }
  catch {
    return undefined
  }
}

// The size of a folder in bytes and how many of its entries another user owns, by `find` where there is one and by a walk otherwise.
export async function measure(folder: string, uid = OWN_UID): Promise<Measure> {
  return await findSize(folder, uid) ?? await walk(folder, uid)
}

export async function sizeOf(folder: string): Promise<number> {
  return (await measure(folder)).bytes
}
