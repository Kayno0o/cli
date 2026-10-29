import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const MAX_AGE_MS = 24 * 60 * 60 * 1000

export function logDir(): string {
  return join(tmpdir(), `out-logs-${process.getuid?.() ?? 0}`)
}

// Removes the logs older than a day, best effort since another run may be doing the same.
export async function cleanLogs(dir = logDir(), now = Date.now()): Promise<void> {
  let names: string[]

  try {
    names = await readdir(dir)
  }
  catch {
    return
  }

  for (const name of names) {
    const path = join(dir, name)

    try {
      if (now - (await stat(path)).mtimeMs > MAX_AGE_MS)
        await rm(path, { force: true })
    }
    catch {
      continue
    }
  }
}

export async function saveLog(output: Uint8Array, dir = logDir()): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await cleanLogs(dir)

  const path = join(dir, `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}.log`)

  await writeFile(path, output)

  return path
}
