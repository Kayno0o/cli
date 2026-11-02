import type { Dotenv } from './dotenv'
import type { KnownSecrets } from './mask'
import { chmod, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fail } from '@kaynooo/cli-kit'
import { entries, parseDotenv, serializeDotenv } from './dotenv'
import { isSecretKey, knownSecrets, urlPasswords } from './mask'

// A dotenv file's name, and the templates among them that hold no values.
export const ENV_FILE = /^\.env(?:\..+)?$/
export const TEMPLATE = /\.(?:example|sample|template|dist|defaults)$/

// The .env* files of a folder, sorted.
export async function envFiles(folder = process.cwd()): Promise<string[]> {
  const found = await readdir(folder, { withFileTypes: true })

  return found.filter(entry => entry.isFile() && ENV_FILE.test(entry.name)).map(entry => entry.name).sort()
}

export async function readEnv(path: string): Promise<Dotenv> {
  const file = Bun.file(path)

  if (!await file.exists())
    fail(`${path} does not exist`)

  return parseDotenv(await file.text())
}

// Writes through a temp file in the same folder renamed over the target, so a crash or a full disk never leaves a half-written file. The target keeps its mode and a new file is 0600.
export async function writeEnv(path: string, file: Dotenv): Promise<void> {
  let target = path
  let mode = 0o600

  try {
    target = await realpath(path)
    mode = (await stat(target)).mode & 0o777
  }
  catch {
    // a missing file is created below
  }

  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`)

  try {
    await writeFile(temp, serializeDotenv(file), { mode: 0o600, flag: 'wx' })
    await chmod(temp, mode)
    await rename(temp, target)
  }
  finally {
    await rm(temp, { force: true })
  }
}

// The secrets of the folder's .env* files, ready to be searched for in output: values of secret-looking keys and the password of any URL value.
export async function loadKnown(folder = process.cwd()): Promise<KnownSecrets> {
  const pairs: [string, string][] = []

  for (const name of await envFiles(folder)) {
    for (const [key, value] of entries(parseDotenv(await Bun.file(`${folder}/${name}`).text()))) {
      if (isSecretKey(key))
        pairs.push([key, value])
      else
        pairs.push(...urlPasswords(value).map(password => [key, password] as [string, string]))
    }
  }

  return knownSecrets(pairs)
}
