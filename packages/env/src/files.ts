import type { Dirent } from 'node:fs'
import type { Dotenv } from './dotenv'
import type { KnownSecrets } from './mask'
import { chmod, chown, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fail, isSecretName } from '@kaynooo/cli-kit'
import { entries, parseDotenv, serializeDotenv } from './dotenv'
import { knownSecrets, urlPasswords } from './mask'

// A dotenv file's name (`.env`, `.env.local`, `prod.env`, `.envrc`), and the templates among them that hold no values.
export const ENV_FILE = /^(?:\.env(?:\..+)?|.+\.env|\.envrc)$/
export const TEMPLATE = /\.(?:example|sample|template|dist|defaults)$/

// Folders searched for secrets below the current one, and the ones never entered.
const KNOWN_DEPTH = 3
const SKIPPED = new Set(['node_modules', '.git', 'vendor'])
const LOCK_WAIT_MS = 5000
const LOCK_STALE_MS = 30_000

// A regular file, or a link to one (a dangling link or a link to a folder is not).
export async function isFileEntry(entry: Dirent, path: string): Promise<boolean> {
  if (entry.isFile())
    return true

  if (!entry.isSymbolicLink())
    return false

  try {
    return (await stat(path)).isFile()
  }
  catch {
    return false
  }
}

// The .env* files of a folder, sorted.
export async function envFiles(folder = process.cwd()): Promise<string[]> {
  const found = await readdir(folder, { withFileTypes: true })
  const names: string[] = []

  for (const entry of found) {
    if (ENV_FILE.test(entry.name) && await isFileEntry(entry, join(folder, entry.name)))
      names.push(entry.name)
  }

  return names.sort()
}

export async function readEnv(path: string): Promise<Dotenv> {
  const file = Bun.file(path)

  if (!await file.exists())
    fail(`${path} does not exist`)

  return parseDotenv(await file.text())
}

// Writes through a temp file in the same folder renamed over the target, so a crash or a full disk never leaves a half-written file. The target keeps its mode, owner and group and a new file is 0600.
export async function writeAtomic(path: string, text: string): Promise<void> {
  let target = path
  let mode = 0o600
  let owner: { uid: number, gid: number } | undefined

  try {
    target = await realpath(path)

    const current = await stat(target)

    mode = current.mode & 0o777
    owner = current
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
  }

  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`)

  try {
    await writeFile(temp, text, { mode: 0o600, flag: 'wx' })

    if (owner !== undefined)
      await keepOwner(temp, owner)

    await chmod(temp, mode)
    await rename(temp, target)
  }
  finally {
    await rm(temp, { force: true })
  }
}

// Gives the file back to its owner when a root run would otherwise take it; anyone else cannot change owners and already owns what they write.
async function keepOwner(path: string, owner: { uid: number, gid: number }): Promise<void> {
  try {
    await chown(path, owner.uid, owner.gid)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM')
      throw error
  }
}

export async function writeEnv(path: string, file: Dotenv): Promise<void> {
  await writeAtomic(path, serializeDotenv(file))
}

// Runs `fn` holding a lock file beside each path, so two ev runs never read-modify-write the same file at once. A lock older than LOCK_STALE_MS belongs to a dead run and is taken over.
export async function withLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const held: string[] = []

  try {
    for (const path of [...new Set(paths)].sort())
      held.push(await acquire(path))

    return await fn()
  }
  finally {
    for (const lock of held)
      await rm(lock, { force: true })
  }
}

// Removes a stale lock under a guard file, so that of two waiters seeing it stale the second one reads the fresh lock the first one's successor wrote instead of removing it.
async function reap(lock: string): Promise<void> {
  const guard = `${lock}.reap`

  try {
    await writeFile(guard, String(process.pid), { flag: 'wx', mode: 0o600 })
  }
  catch {
    return
  }

  try {
    if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS)
      await rm(lock, { force: true })
  }
  catch {
    // released between the two calls
  }
  finally {
    await rm(guard, { force: true })
  }
}

async function acquire(path: string): Promise<string> {
  let real = path

  try {
    real = await realpath(path)
  }
  catch {
    // a missing file is locked by its own name
  }

  const lock = join(dirname(real), `.${basename(real)}.lock`)
  const deadline = Date.now() + LOCK_WAIT_MS

  while (true) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 })

      return lock
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error
    }

    await reap(lock)

    if (Date.now() > deadline)
      fail(`${path} is locked by another ev run (${lock})`, 1)

    await Bun.sleep(25)
  }
}

// The secrets of a parsed file: values of secret-looking keys and the password of any URL value.
export function secretPairs(file: Dotenv): [string, string][] {
  const pairs: [string, string][] = []

  for (const [key, value] of entries(file)) {
    if (isSecretName(key))
      pairs.push([key, value])
    else
      pairs.push(...urlPasswords(value).map(password => [key, password] as [string, string]))
  }

  return pairs
}

// The .env* files of a folder and of the folders below it, down to KNOWN_DEPTH.
async function envFilesBelow(folder: string, depth = 0): Promise<string[]> {
  const found: string[] = []
  let children: Dirent[]

  try {
    children = await readdir(folder, { withFileTypes: true })
  }
  catch {
    return found
  }

  for (const entry of children) {
    const path = join(folder, entry.name)

    if (entry.isDirectory() && depth < KNOWN_DEPTH && !SKIPPED.has(entry.name))
      found.push(...await envFilesBelow(path, depth + 1))
    else if (ENV_FILE.test(entry.name) && await isFileEntry(entry, path))
      found.push(path)
  }

  return found
}

// The secrets of the folder's .env* files and of those in the folders below it, plus any `extra` parsed file, ready to be searched for in output.
export async function loadKnown(folder = process.cwd(), extra: Dotenv[] = []): Promise<KnownSecrets> {
  const pairs = extra.flatMap(secretPairs)

  for (const path of await envFilesBelow(folder)) {
    try {
      pairs.push(...secretPairs(parseDotenv(await Bun.file(path).text())))
    }
    catch {
      // a file that cannot be read has no secret to learn
    }
  }

  return knownSecrets(pairs)
}
