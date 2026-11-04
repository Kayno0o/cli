import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fail, runTool } from '@kaynooo/cli-kit'
import { redactUrl } from './remote'

const LOGIN_HOST = /^\s*(?:-\s*)?(?:url|ssh_host):\s*["']?([^\s"']+)/gm
const PORT = /:\d+$/
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/
const URL_REMOTE = /^[a-z+]+:\/\/(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\s]+)/i

// The host of a git remote, `git@host:owner/repo.git` or `https://host/owner/repo` alike.
export function originHost(remote: string): string | undefined {
  const text = remote.trim()

  return (URL_REMOTE.exec(text) ?? SCP_REMOTE.exec(text))?.[1]?.toLowerCase()
}

// The hosts tea has a login for, read from its config rather than asked of the tea binary: the url and ssh_host of each login, port dropped.
export function loginHosts(config: string): Set<string> {
  const hosts = new Set<string>()

  for (const [, value = ''] of config.matchAll(LOGIN_HOST)) {
    const host = URL.canParse(value) ? new URL(value).hostname : value.replace(PORT, '')

    if (host !== '')
      hosts.add(host.toLowerCase())
  }

  return hosts
}

function teaConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME

  return join(base !== undefined && base !== '' ? base : join(homedir(), '.config'), 'tea', 'config.yml')
}

async function readConfig(): Promise<string> {
  try {
    return await Bun.file(teaConfigPath()).text()
  }
  catch {
    return ''
  }
}

let checked: Promise<void> | undefined

// Refuses, as a usage error, a call that leaves {owner}/{repo} to tea in a repository whose origin is not on a Forgejo tea is logged in to: tea would answer a 404 or a user lookup error that reads like a real failure. Silent when tea's config cannot be read or there is no origin to judge.
export async function requireForgeOrigin(): Promise<void> {
  checked ??= (async () => {
    const hosts = loginHosts(await readConfig())

    if (hosts.size === 0)
      return

    const origin = await runTool('git remote get-url origin', ['git', 'remote', 'get-url', 'origin'], { timeoutMs: 5000 })
    const host = origin.code === 0 ? originHost(origin.stdout) : undefined

    if (host !== undefined && !hosts.has(host))
      fail(`origin ${redactUrl(origin.stdout.trim())} is not on a Forgejo tea is logged in to (${[...hosts].join(', ')})`, 2, 'name the repository with -r owner/name, or run ft in a repository hosted there (an ssh alias origin: ft remote --fix)')
  })()

  return checked
}
