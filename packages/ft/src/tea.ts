import { upTo } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { spawnFailure } from './git'

// Every Forgejo call goes through tea, which owns the OAuth login and fills {owner}/{repo} from the cwd's origin, or from --repo.
function repoFlag(repo: string | undefined): string[] {
  return repo === undefined ? [] : ['--repo', repo]
}

async function request(path: string, repo: string | undefined): Promise<string> {
  let result

  try {
    result = await $`tea api ${repoFlag(repo)} ${path}`.quiet().nothrow()
  }
  catch (error) {
    throw spawnFailure(`tea api ${path}`, error)
  }

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

  const failure = apiError(value)

  if (failure !== undefined)
    throw new Error(`tea api ${path}: ${failure}`)

  return value as T
}

// tea exits 0 on an API error and prints Forgejo's error object instead.
function apiError(value: unknown): string | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'message' in value && typeof value.message === 'string' && 'url' in value)
    return value.message

  return undefined
}

export async function api<T>(path: string, repo?: string): Promise<T> {
  return parseJson<T>(path, await request(path, repo))
}

export async function repoApi<T>(path: string, repo?: string): Promise<T> {
  return api<T>(`repos/{owner}/{repo}/${path}`, repo)
}

// A write through `tea api`, each field sent as a string; the flags come before the path, where tea reads them.
export async function repoWrite<T>(method: 'POST' | 'PATCH', path: string, fields: Record<string, string>, repo?: string): Promise<T> {
  const full = `repos/{owner}/{repo}/${path}`
  const flags = Object.entries(fields).flatMap(([name, value]) => ['-f', `${name}=${value}`])
  let result

  try {
    result = await $`tea api ${repoFlag(repo)} -X ${method} ${flags} ${full}`.quiet().nothrow()
  }
  catch (error) {
    throw spawnFailure(`tea api ${full}`, error)
  }

  if (result.exitCode !== 0)
    throw new Error(`tea api ${full}: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`)

  return parseJson<T>(full, result.stdout.toString())
}

// A text answer such as a job log; Forgejo's error object, which tea prints with exit 0, is thrown instead of returned as the text.
export async function repoApiText(path: string, repo?: string): Promise<string> {
  const full = `repos/{owner}/{repo}/${path}`
  const text = await request(full, repo)
  let value: unknown

  try {
    value = JSON.parse(text)
  }
  catch {
    return text
  }

  const failure = apiError(value)

  if (failure !== undefined)
    throw new Error(`tea api ${full}: ${failure}`)

  return text
}

// Runs a tea subcommand (`['issues', 'edit']`) with `--repo` straight after its name, before any positional or flag value that could be read as one.
export async function tea(command: string[], args: string[], repo?: string): Promise<string> {
  let result

  try {
    result = await $`tea ${command} ${repoFlag(repo)} ${args}`.quiet().nothrow()
  }
  catch (error) {
    throw spawnFailure(`tea ${command.join(' ')}`, error)
  }

  if (result.exitCode !== 0)
    throw new Error(`tea ${command.join(' ')}: ${result.stderr.toString().trim() || result.stdout.toString().trim() || `exit ${result.exitCode}`}`)

  return result.stdout.toString()
}
