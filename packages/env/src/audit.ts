import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isSecretName } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { ENV_FILE, isFileEntry, SKIPPED, TEMPLATE } from './files'
import { urlPasswords } from './mask'

export interface Exposure {
  path: string
  // Readable by an account other than its owner: any account, its group or an ACL entry.
  readable: boolean
  // Set when it is readable only through its group or an ACL, not by any account.
  group?: boolean
  tracked: boolean
  // The keys a compose file writes out, for a compose file only.
  secrets?: string[]
}

const MAX_DEPTH = 5
const COMPOSE_FILE = /^(?:docker-)?compose[\w.-]*\.ya?ml$/
// An environment entry, `KEY: value` or `- KEY=value`, with its value written out.
const ENTRY = /^\s*(?:-\s*)?["']?([A-Z0-9_]+)["']?\s*[:=]\s*["']?([^"'\s#]+)/
// A setting about a secret (its lifetime, the file or header holding it), not the secret.
const SETTING_SUFFIX = /_(?:TTL|FILE|PATH|DIR|NAME|TIMEOUT|EXPIRY|EXPIRES|LIFETIME|LENGTH|ENABLED|ALGORITHM|HEADER|PREFIX|COUNT|MAX|MIN)$/i
const ACL_READER = /^(?:user|group):[^:]+:r/
// A switch like MYSQL_RANDOM_ROOT_PASSWORD: 1, not a secret.
const FLAG = /^(?:[01]|yes|no|true|false)$/i

// A compose value written out rather than read from a .env, the environment or a secrets file: a secret-named value or a URL password.
export function isInlineSecret(name: string, value: string): boolean {
  if (value === '' || value.startsWith('$') || value.startsWith('/run/secrets/') || FLAG.test(value))
    return false

  return (isSecretName(name) && !SETTING_SUFFIX.test(name)) || urlPasswords(value).some(password => !password.startsWith('$'))
}

// The names of the secrets a compose file writes out.
export function inlineSecrets(compose: string): string[] {
  const names = compose.split('\n').flatMap((line) => {
    const [, name = '', value = ''] = ENTRY.exec(line) ?? []

    return isInlineSecret(name, value) ? [name] : []
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

/** Whether the group bit lets in a group other than the owner's primary one, which only the owner belongs to on a system with private groups. */
export function groupReads(mode: number, gid: number, ownerGroup: number): boolean {
  return (mode & 0o040) !== 0 && gid !== ownerGroup && gid !== process.getgid?.()
}

// The primary group of an account, the account's own id when the system does not tell.
function primaryGroup(uid: number): number {
  if (uid === process.getuid?.())
    return process.getgid?.() ?? uid

  const run = Bun.spawnSync(['id', '-g', String(uid)], { stdout: 'pipe', stderr: 'ignore' })
  const gid = Number(run.stdout.toString().trim())

  return run.exitCode === 0 && Number.isInteger(gid) ? gid : uid
}

// Accounts other than the owner can read it through a group that is not the owner's own, or through a named user or group of its ACL, and every folder above lets them through.
export async function sharedWith(path: string): Promise<boolean> {
  const info = await stat(path)
  const shared = groupReads(info.mode, info.gid, primaryGroup(info.uid))

  if (!shared && (Bun.which('getfacl') === null || !await hasAclReader(path)))
    return false

  for (let dir = dirname(path); dir !== '/'; dir = dirname(dir)) {
    if (((await stat(dir)).mode & 0o011) === 0)
      return false
  }

  return true
}

async function hasAclReader(path: string): Promise<boolean> {
  const acl = await $`getfacl --absolute-names --omit-header -- ${path}`.quiet().nothrow()

  return acl.exitCode === 0 && acl.stdout.toString().split('\n').some(line => ACL_READER.test(line))
}

// Exit 1 is git saying the file is not tracked, and a folder outside any repository tracks nothing; anything else is git failing, which must not read as untracked.
async function tracked(path: string): Promise<boolean> {
  const run = await $`git ls-files --error-unmatch -- ${path}`.cwd(dirname(path)).quiet().nothrow()
  const error = run.stderr.toString()

  if (run.exitCode === 0)
    return true

  if (run.exitCode === 1 || error.includes('not a git repository'))
    return false

  throw new Error(`git could not tell whether ${path} is tracked: ${error.trim() || `exit ${run.exitCode}`}`)
}

// The .env* and compose files under root, down to MAX_DEPTH folders, skipping dependency and git folders and following no link; a folder it cannot read goes to `unread`.
async function* candidates(root: string, unread: string[], depth = 0): AsyncGenerator<string> {
  let found: Dirent[]

  try {
    found = await readdir(root, { withFileTypes: true })
  }
  catch {
    unread.push(root)

    return
  }

  for (const entry of found) {
    const path = join(root, entry.name)

    if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED.has(entry.name))
      yield* candidates(path, unread, depth + 1)
    else if (!TEMPLATE.test(entry.name) && (ENV_FILE.test(entry.name) || COMPOSE_FILE.test(entry.name)) && await isFileEntry(entry, path))
      yield path
  }
}

// The .env files any account can read or git tracks, and the compose files writing secrets out that any account can read: tracked dev composes with throwaway passwords are left out as too common.
export async function audit(roots: string[]): Promise<{ exposed: Exposure[], unread: string[] }> {
  const exposed: Exposure[] = []
  const unread: string[] = []

  for (const root of roots) {
    for await (const path of candidates(root, unread)) {
      const others = await openToOthers(path)
      const readable = others || await sharedWith(path)
      const group = readable && !others ? true : undefined
      const name = path.slice(path.lastIndexOf('/') + 1)

      if (ENV_FILE.test(name)) {
        const isTracked = await tracked(path)

        if (readable || isTracked)
          exposed.push({ path, readable, ...group && { group }, tracked: isTracked })

        continue
      }

      const secrets = readable ? inlineSecrets(await Bun.file(path).text()) : []

      if (secrets.length > 0)
        exposed.push({ path, readable, ...group && { group }, tracked: false, secrets })
    }
  }

  return { exposed: exposed.sort((a, b) => a.path.localeCompare(b.path)), unread }
}
