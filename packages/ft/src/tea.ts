import type { ForgeTarget, Provider } from './provider'
import { upTo } from '@kaynooo/cli-kit'
import { encodeGitLabProject, resolveForge } from './provider'

const REQUEST_MS = 60_000
const LEADING_SLASHES = /^\/+/

function scrub(text: string, token: string | undefined): string {
  return token === undefined || token === '' ? text : text.replaceAll(token, '***')
}

function authHeaders(target: ForgeTarget, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {}

  if (target.provider === 'github') {
    headers.accept = 'application/vnd.github+json'
    headers['x-github-api-version'] = '2022-11-28'

    if (target.token !== undefined && target.token !== '')
      headers.authorization = `Bearer ${target.token}`
  }
  else if (target.provider === 'gitlab') {
    headers.accept = 'application/json'

    if (target.token !== undefined && target.token !== '')
      headers['private-token'] = target.token
  }
  else {
    headers.accept = 'application/json'

    if (target.token !== undefined && target.token !== '')
      headers.authorization = `token ${target.token}`
  }

  if (hasBody)
    headers['content-type'] = 'application/json'

  return headers
}

function extractApiError(body: string, status: number, statusText: string, token: string | undefined): string {
  try {
    const parsed: unknown = JSON.parse(body)

    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if ('message' in parsed && typeof parsed.message === 'string' && parsed.message !== '')
        return scrub(parsed.message, token)

      if ('error' in parsed && typeof parsed.error === 'string' && parsed.error !== '')
        return scrub(parsed.error, token)
    }
  }
  catch {
    // Not JSON
  }

  return scrub(upTo(body.trim(), '\n') || `${status} ${statusText}`, token)
}

function expandPath(path: string, target: ForgeTarget): string {
  const trimmed = path.replace(LEADING_SLASHES, '')

  if (target.provider === 'gitlab')
    return trimmed.replace('projects/:id', `projects/${encodeGitLabProject(target.repo)}`).replace('repos/{owner}/{repo}', `projects/${encodeGitLabProject(target.repo)}`)

  return trimmed.replace('repos/{owner}/{repo}', `repos/${target.repo}`)
}

export async function forgeRequest(path: string, options: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown, repo?: string | undefined, provider?: Provider | undefined, target?: ForgeTarget | undefined } = {}): Promise<{ status: number, text: string, target: ForgeTarget }> {
  const target = options.target ?? await resolveForge(options.repo, options.provider)
  const method = options.method ?? 'GET'
  const expanded = expandPath(path, target)
  const url = expanded.startsWith('http://') || expanded.startsWith('https://') ? expanded : `${target.apiBase}/${expanded}`
  const hasBody = options.body !== undefined
  const init: RequestInit = {
    method,
    headers: authHeaders(target, hasBody),
    signal: AbortSignal.timeout(REQUEST_MS),
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
  }

  let response: Response

  try {
    response = await fetch(url, init)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    throw new Error(`${target.provider} api ${expanded}: ${scrub(message, target.token)}`)
  }

  const text = await response.text()

  if (!response.ok)
    throw new Error(`${target.provider} api ${expanded}: ${extractApiError(text, response.status, response.statusText, target.token)}`)

  return { status: response.status, text, target }
}

function parseJson<T>(label: string, text: string, target: ForgeTarget): T {
  let value: unknown

  try {
    value = JSON.parse(text)
  }
  catch {
    throw new Error(`${target.provider} api ${label}: ${scrub(upTo(text.trim(), '\n') || 'empty answer', target.token)}`)
  }

  return value as T
}

export async function api<T>(path: string, repo?: string): Promise<T> {
  const { text, target } = await forgeRequest(path, { repo })

  return parseJson<T>(path, text, target)
}

export async function repoApi<T>(path: string, repo?: string): Promise<T> {
  const target = await resolveForge(repo)
  const prefix = target.provider === 'gitlab' ? `projects/${encodeGitLabProject(target.repo)}` : `repos/${target.repo}`
  const full = `${prefix}/${path}`
  const { text } = await forgeRequest(full, { target })

  return parseJson<T>(full, text, target)
}

export async function repoSend(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, fields?: Record<string, unknown>, repo?: string): Promise<string> {
  const target = await resolveForge(repo)
  const prefix = target.provider === 'gitlab' ? `projects/${encodeGitLabProject(target.repo)}` : `repos/${target.repo}`
  const full = `${prefix}/${path}`
  const body = fields !== undefined && Object.keys(fields).length > 0 ? fields : undefined
  const { text } = await forgeRequest(full, { method, body, target })

  return text
}

export async function repoWriteOrEmpty<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, fields: Record<string, unknown>, repo?: string): Promise<T | undefined> {
  const target = await resolveForge(repo)
  const prefix = target.provider === 'gitlab' ? `projects/${encodeGitLabProject(target.repo)}` : `repos/${target.repo}`
  const full = `${prefix}/${path}`
  const { text } = await forgeRequest(full, { method, body: fields, target })

  return text.trim() === '' ? undefined : parseJson<T>(full, text, target)
}

export async function repoWrite<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, fields: Record<string, unknown>, repo?: string): Promise<T> {
  const target = await resolveForge(repo)
  const prefix = target.provider === 'gitlab' ? `projects/${encodeGitLabProject(target.repo)}` : `repos/${target.repo}`
  const full = `${prefix}/${path}`
  const { text } = await forgeRequest(full, { method, body: fields, target })

  return parseJson<T>(full, text, target)
}

export async function repoApiText(path: string, repo?: string): Promise<string> {
  const target = await resolveForge(repo)
  const prefix = target.provider === 'gitlab' ? `projects/${encodeGitLabProject(target.repo)}` : `repos/${target.repo}`
  const { text } = await forgeRequest(`${prefix}/${path}`, { target })

  return text
}

export async function repoDefaultBranch(repo?: string): Promise<string> {
  const target = await resolveForge(repo)
  const path = target.provider === 'gitlab' ? `projects/${encodeGitLabProject(target.repo)}` : `repos/${target.repo}`
  const { text } = await forgeRequest(path, { target })
  const data = parseJson<{ default_branch?: string }>(path, text, target)

  return data.default_branch ?? 'main'
}

export { resolveForge } from './provider'
export type { ForgeTarget, Provider } from './provider'
