import process from 'node:process'
import { runTool, upTo } from '@kaynooo/cli-kit'
import { pickLogin, requireForgeOrigin } from './forge'

// How long one tea call may take before it is given up; the wait loops poll again.
const TEA_MS = 60_000

// Every Forgejo call goes through tea, which owns the OAuth login and fills {owner}/{repo} from the cwd's origin, or from --repo. Without tea, `gt` (gitea-cli) takes over, with the token of tea's config when no token is set.
function repoFlag(repo: string | undefined): string[] {
  return repo === undefined ? [] : ['--repo', repo]
}

// True when tea is not installed and gt is: the fallback client.
export function usesGt(): boolean {
  const PATH = process.env.PATH ?? ''

  return Bun.which('tea', { PATH }) === null && Bun.which('gt', { PATH }) !== null
}

let injected: string | undefined

// gt keeps its own logins, so tea's token and host reach it through the environment unless the caller already set a token.
async function injectLogin(repo: string | undefined): Promise<void> {
  if (process.env.GITEA_TOKEN !== undefined && process.env.GITEA_TOKEN !== '')
    return

  const login = await pickLogin(repo === undefined)

  if (login === undefined)
    return

  injected = login.token
  process.env.GITEA_TOKEN = login.token
  process.env.GITEA_CLI_HOST = login.url
}

// The token never shows in a message, whichever way it got there.
function scrub(text: string): string {
  const token = injected ?? process.env.GITEA_TOKEN

  return token === undefined || token === '' ? text : text.replaceAll(token, '***')
}

// gt prints a non-2xx response's body and exits non-zero; Forgejo's message is the useful part.
function failureText(stdout: string, stderr: string, code: number): string {
  try {
    const value: unknown = JSON.parse(stdout)

    if (value !== null && typeof value === 'object' && 'message' in value && typeof value.message === 'string')
      return scrub(value.message)
  }
  catch {}

  return scrub(stderr.trim() || stdout.trim() || `exit ${code}`)
}

// Runs `<client> api ...` and returns its output, or throws with the client's error.
async function runApi(label: string, args: string[], repo: string | undefined): Promise<string> {
  if (repo === undefined)
    await requireForgeOrigin()

  const gt = usesGt()
  const bin = gt ? 'gt' : 'tea'

  if (gt)
    await injectLogin(repo)

  const result = await runTool(`${bin} api ${label}`, [bin, 'api', ...repoFlag(repo), ...args], { timeoutMs: TEA_MS })

  if (result.code !== 0)
    throw new Error(`${bin} api ${label}: ${gt ? failureText(result.stdout, result.stderr, result.code) : result.stderr.trim() || `exit ${result.code}`}`)

  return gt ? scrub(result.stdout) : result.stdout
}

async function request(path: string, repo: string | undefined): Promise<string> {
  return runApi(path, [path], repo)
}

function clientName(): string {
  return usesGt() ? 'gt' : 'tea'
}

function parseJson<T>(path: string, text: string): T {
  let value: unknown

  try {
    value = JSON.parse(text)
  }
  catch {
    throw new Error(`${clientName()} api ${path}: ${upTo(text.trim(), '\n') || 'empty answer'}`)
  }

  const failure = apiError(value)

  if (failure !== undefined)
    throw new Error(`${clientName()} api ${path}: ${failure}`)

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

// A write through `api`: a string field is sent with -f, any other value (a number, an array) as typed JSON with -F; the flags come before the path, where tea reads them.
export async function repoSend(method: 'POST' | 'PATCH' | 'DELETE', path: string, fields: Record<string, unknown>, repo?: string): Promise<string> {
  const full = `repos/{owner}/{repo}/${path}`
  const flags = Object.entries(fields).flatMap(([name, value]) => typeof value === 'string' ? ['-f', `${name}=${value}`] : ['-F', `${name}=${JSON.stringify(value)}`])

  return runApi(full, ['-X', method, ...flags, full], repo)
}

export async function repoWrite<T>(method: 'POST' | 'PATCH', path: string, fields: Record<string, unknown>, repo?: string): Promise<T> {
  return parseJson<T>(`repos/{owner}/{repo}/${path}`, await repoSend(method, path, fields, repo))
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
    throw new Error(`${clientName()} api ${full}: ${failure}`)

  return text
}

// Runs a tea subcommand (`['issues', 'edit']`) with `--repo` straight after its name, before any positional or flag value that could be read as one. Callers go through the API instead when `usesGt()`.
export async function tea(command: string[], args: string[], repo?: string): Promise<string> {
  if (repo === undefined)
    await requireForgeOrigin()

  const result = await runTool(`tea ${command.join(' ')}`, ['tea', ...command, ...repoFlag(repo), ...args], { timeoutMs: TEA_MS })

  if (result.code !== 0)
    throw new Error(`tea ${command.join(' ')}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`)

  return result.stdout
}
