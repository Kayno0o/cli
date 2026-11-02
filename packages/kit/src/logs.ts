import { lstatSync, openSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const DAY_MS = 24 * 60 * 60 * 1000

// Whether the folder is a real directory (not a link) that only this user can use.
function isPrivateDirectory(path: string): boolean {
  try {
    const info = lstatSync(path, { throwIfNoEntry: false })

    return info !== undefined && info.isDirectory() && info.uid === (process.getuid?.() ?? info.uid) && (info.mode & 0o077) === 0
  }
  catch {
    return false
  }
}

// A folder for log files that only this user can read: `<name>` under $XDG_RUNTIME_DIR, else ~/.cache/agent-tools. When one already exists it must be a private directory of this user, otherwise a fresh private folder in the temp directory is used instead of trusting it.
export async function privateLogDirectory(name: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const runtime = env.XDG_RUNTIME_DIR
  const base = runtime === undefined || runtime === '' ? join(homedir(), '.cache', 'agent-tools') : join(runtime, 'agent-tools')
  const path = join(base, name)

  try {
    await mkdir(path, { recursive: true, mode: 0o700 })

    if (isPrivateDirectory(path))
      return path
  }
  catch {
    // Falls through to the temp folder below.
  }

  return mkdtemp(join(tmpdir(), `${name.replaceAll('/', '-')}-`))
}

// Removes what is older than `maxAgeMs` in the folder, and the empty subfolders it leaves, best effort since another run may be doing the same.
export async function sweepLogs(dir: string, maxAgeMs = DAY_MS, now = Date.now()): Promise<void> {
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
      const info = await stat(path)

      if (info.isDirectory())
        await sweepLogs(path, maxAgeMs, now)

      if (now - info.mtimeMs > maxAgeMs)
        await rm(path, { force: true, recursive: info.isDirectory() })
    }
    catch {
      continue
    }
  }
}

// Creates a log file nobody else can read and that must not exist yet, so a planted link is never followed; returns its descriptor, for writeSync.
export function createLog(path: string): number {
  return openSync(path, 'wx', 0o600)
}
