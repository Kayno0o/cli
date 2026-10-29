import { upTo } from '@kaynooo/cli-kit'
import { $ } from 'bun'

// Every Forgejo call goes through tea, which owns the OAuth login and fills {owner}/{repo} from the cwd's origin, or from --repo.
function repoFlag(repo: string | undefined): string[] {
  return repo === undefined ? [] : ['--repo', repo]
}

async function request(path: string, repo: string | undefined): Promise<string> {
  const result = await $`tea api ${repoFlag(repo)} ${path}`.quiet().nothrow()

  if (result.exitCode !== 0)
    throw new Error(`tea api ${path}: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`)

  return result.stdout.toString()
}

function parseJson<T>(path: string, text: string): T {
  let value: unknown

  try {
    value = JSON.parse(text)
  }
  catch {
    throw new Error(`tea api ${path}: ${upTo(text.trim(), '\n') || 'empty answer'}`)
  }

  // tea exits 0 on an API error and prints Forgejo's error object instead.
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'message' in value && typeof value.message === 'string' && 'url' in value)
    throw new Error(`tea api ${path}: ${value.message}`)

  return value as T
}

export async function api<T>(path: string, repo?: string): Promise<T> {
  return parseJson<T>(path, await request(path, repo))
}

export async function repoApi<T>(path: string, repo?: string): Promise<T> {
  return api<T>(`repos/{owner}/{repo}/${path}`, repo)
}

export async function repoApiText(path: string, repo?: string): Promise<string> {
  return request(`repos/{owner}/{repo}/${path}`, repo)
}

export async function tea(args: string[], repo?: string): Promise<string> {
  const result = await $`tea ${args} ${repoFlag(repo)}`.quiet().nothrow()

  if (result.exitCode !== 0)
    throw new Error(`tea ${args[0] ?? ''}: ${result.stderr.toString().trim() || result.stdout.toString().trim() || `exit ${result.exitCode}`}`)

  return result.stdout.toString()
}
