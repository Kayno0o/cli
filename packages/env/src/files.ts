import type { Dotenv } from './dotenv'
import type { KnownSecrets } from './mask'
import { readdir } from 'node:fs/promises'
import { fail } from '@kaynooo/cli-kit'
import { entries, parseDotenv, serializeDotenv } from './dotenv'
import { isSecretKey, knownSecrets, urlPasswords } from './mask'

const ENV_FILE = /^\.env(?:\..+)?$/

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

export async function writeEnv(path: string, file: Dotenv): Promise<void> {
  await Bun.write(path, serializeDotenv(file))
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
