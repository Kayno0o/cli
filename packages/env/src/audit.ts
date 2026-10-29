import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { $ } from 'bun'
import { urlPasswords } from './mask'

export interface Exposure {
  path: string
  readable: boolean
  tracked: boolean
  // The keys a compose file writes out, for a compose file only.
  secrets?: string[]
}

const MAX_DEPTH = 5
const SKIPPED = new Set(['node_modules', '.git', 'vendor'])
const ENV_FILE = /^\.env(?:\..+)?$/
const TEMPLATE = /\.(?:example|sample|template|dist)$/
const COMPOSE_FILE = /^(?:docker-)?compose(?:\.[\w-]+)*\.ya?ml$/
// An environment entry, `KEY: value` or `- KEY=value`, with its value written out.
const ENTRY = /^\s*(?:-\s*)?["']?([A-Z0-9_]+)["']?\s*[:=]\s*["']?([^"'\s#]+)/
const SECRET_NAME = /(?:PASSWORD|PASSWD|SECRET|TOKEN|KEY)$/
// A switch like MYSQL_RANDOM_ROOT_PASSWORD: 1, not a secret.
const FLAG = /^(?:[01]|yes|no|true|false)$/i

// The names of the secrets a compose file writes out rather than reading from a .env, the environment or a secrets file: secret-named values and URL passwords.
export function inlineSecrets(compose: string): string[] {
  const names = compose.split('\n').flatMap((line) => {
    const [, name = '', value = ''] = ENTRY.exec(line) ?? []

    if (value.startsWith('$') || value.startsWith('/run/secrets/') || FLAG.test(value))
      return []

    return SECRET_NAME.test(name) || urlPasswords(value).some(password => !password.startsWith('$')) ? [name] : []
  })

  return [...new Set(names)]
}

// Any account can read it: the file lets others read and every folder above it lets them through.
export async function openToOthers(path: string): Promise<boolean> {
  if (((await stat(path)).mode & 0o004) === 0)
    return false

  for (let dir = dirname(path); dir !== '/'; dir = dirname(dir)) {
    if (((await stat(dir)).mode & 0o001) === 0)
      return false
  }

  return true
}

async function tracked(path: string): Promise<boolean> {
  return (await $`git ls-files --error-unmatch -- ${path}`.cwd(dirname(path)).quiet().nothrow()).exitCode === 0
}

// The .env* and compose files under root, down to MAX_DEPTH folders, skipping dependency and git folders and following no link.
async function* candidates(root: string, depth = 0): AsyncGenerator<string> {
  let found: Dirent[]

  try {
    found = await readdir(root, { withFileTypes: true })
  }
  catch {
    return
  }

  for (const entry of found) {
    const path = join(root, entry.name)

    if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED.has(entry.name))
      yield* candidates(path, depth + 1)
    else if (entry.isFile() && !TEMPLATE.test(entry.name) && (ENV_FILE.test(entry.name) || COMPOSE_FILE.test(entry.name)))
      yield path
  }
}

// The .env files any account can read or git tracks, and the compose files writing secrets out that any account can read: tracked dev composes with throwaway passwords are left out as too common.
export async function audit(roots: string[]): Promise<Exposure[]> {
  const exposed: Exposure[] = []

  for (const root of roots) {
    for await (const path of candidates(root)) {
      const readable = await openToOthers(path)
      const name = path.slice(path.lastIndexOf('/') + 1)

      if (ENV_FILE.test(name)) {
        const isTracked = await tracked(path)

        if (readable || isTracked)
          exposed.push({ path, readable, tracked: isTracked })

        continue
      }

      const secrets = readable ? inlineSecrets(await Bun.file(path).text()) : []

      if (secrets.length > 0)
        exposed.push({ path, readable, tracked: false, secrets })
    }
  }

  return exposed.sort((a, b) => a.path.localeCompare(b.path))
}
