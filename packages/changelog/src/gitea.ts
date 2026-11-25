import type { AuthorInfo, ChangelogOptions, Commit } from './types'
import path from 'node:path'
import { writeErr } from '@kaynooo/cli-kit'
import { err, out } from './ui'

const REQUEST_MS = 60_000

interface GiteaRelease {
  id: number
  name: string
  url: string
  html_url: string
}

interface GiteaCommit {
  // GitHub leaves it null for an email no account claims.
  author: { login: string, avatar_url: string } | null
}

function onGithub(options: ChangelogOptions): boolean {
  return options.provider === 'github'
}

function onGitlab(options: ChangelogOptions): boolean {
  return options.provider === 'gitlab'
}

function gitlabProject(repo: string | undefined): string {
  return `projects/${encodeURIComponent(repo ?? '')}`
}

// GitHub reads a tag as a git ref, under `ref` to read and `refs` to delete; GitLab uses repository/tags; Forgejo has a tags endpoint.
function tagPath(options: ChangelogOptions, repo: string | undefined, tag: string, write = false): string {
  if (onGitlab(options))
    return `${gitlabProject(repo)}/repository/tags/${encodeURIComponent(tag)}`

  return onGithub(options) ? `repos/${repo}/git/${write ? 'refs' : 'ref'}/tags/${encodeURIComponent(tag)}` : `repos/${repo}/tags/${encodeURIComponent(tag)}`
}

async function request(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) })

  if (!res.ok)
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`)

  return res
}

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  return await (await request(url, init)).json() as T
}

export async function sendRelease(
  options: ChangelogOptions,
  content: string,
) {
  const headers = getHeaders(options)

  if (onGitlab(options)) {
    const tag = options.to ?? ''
    const project = gitlabProject(options.releaseRepo)
    const exists = await getRelease(options, tag)
    const url = exists !== null
      ? `https://${options.baseUrlApi}/${project}/releases/${encodeURIComponent(tag)}`
      : `https://${options.baseUrlApi}/${project}/releases`
    const method = exists !== null ? 'PUT' : 'POST'
    const body = exists !== null
      ? { name: options.name ?? tag, description: content }
      : { tag_name: tag, name: options.name ?? tag, description: content }

    console.log(out().cyan(method === 'POST' ? 'Creating release notes...' : 'Updating release notes...'))
    const res = await api<{ _links?: { self?: string } }>(url, {
      method,
      body: JSON.stringify(body),
      headers: { ...headers, 'content-type': 'application/json' },
    })
    const releaseUrl = res._links?.self ?? `https://${options.baseUrl}/${options.releaseRepo}/-/releases/${encodeURIComponent(tag)}`

    console.log(out().green(`Released on ${releaseUrl}`))

    return releaseUrl
  }

  let url = `https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases`
  let method = 'POST'

  try {
    const exists = await api<GiteaRelease>(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/tags/${encodeURIComponent(options.to ?? '')}`, {
      headers,
    })

    if (exists.url) {
      url = exists.url
      method = 'PATCH'
    }
  }
  catch {
  }

  const body = {
    body: content,
    draft: options.draft || false,
    name: options.name ?? options.to,
    prerelease: options.prerelease,
    tag_name: options.to,
  }

  console.log(out().cyan(method === 'POST'
    ? 'Creating release notes...'
    : 'Updating release notes...'),
  )
  const res = await api<GiteaRelease>(url, {
    method,
    body: JSON.stringify(body),
    headers: { ...headers, 'content-type': 'application/json' },
  })

  console.log(out().green(`Released on ${res.html_url}`))

  return res.html_url
}

export async function getRelease(options: ChangelogOptions, tag: string) {
  try {
    if (onGitlab(options)) {
      const data = await api<{ tag_name: string, name?: string, _links?: { self?: string } }>(`https://${options.baseUrlApi}/${gitlabProject(options.releaseRepo)}/releases/${encodeURIComponent(tag)}`, {
        headers: getHeaders(options),
      })

      return { id: 0, name: data.name ?? data.tag_name, url: data._links?.self ?? '', html_url: data._links?.self ?? '' }
    }

    return await api<GiteaRelease>(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: getHeaders(options),
    })
  }
  catch {
    return null
  }
}

export async function deleteRelease(options: ChangelogOptions, releaseId: number, tag?: string) {
  if (onGitlab(options)) {
    await request(`https://${options.baseUrlApi}/${gitlabProject(options.releaseRepo)}/releases/${encodeURIComponent(tag ?? options.to ?? '')}`, {
      method: 'DELETE',
      headers: getHeaders(options),
    })

    return
  }

  await request(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/${releaseId}`, {
    method: 'DELETE',
    headers: getHeaders(options),
  })
}

export async function hasRemoteTag(options: ChangelogOptions, tag: string) {
  try {
    await api(`https://${options.baseUrlApi}/${tagPath(options, options.releaseRepo, tag)}`, {
      headers: getHeaders(options),
    })

    return true
  }
  catch {
    return false
  }
}

export async function deleteRemoteTag(options: ChangelogOptions, tag: string) {
  await request(`https://${options.baseUrlApi}/${tagPath(options, options.releaseRepo, tag, true)}`, {
    method: 'DELETE',
    headers: getHeaders(options),
  })
}

function getHeaders(options: ChangelogOptions): Record<string, string> {
  if (onGithub(options))
    return { 'accept': 'application/vnd.github+json', 'authorization': `Bearer ${options.token}`, 'x-github-api-version': '2022-11-28' }

  if (onGitlab(options))
    return { 'accept': 'application/json', 'private-token': options.token ?? '' }

  return {
    accept: 'application/vnd.gitea.v3+json',
    authorization: `token ${options.token}`,
  }
}

const excludeAuthors = [
  /\[bot\]/i,
  /dependabot/i,
  /\(bot\)/i,
]

export async function resolveAuthorInfo(options: ChangelogOptions, info: AuthorInfo) {
  if ((info.login ?? '') !== '' || onGitlab(options))
    return info

  // token not provided, skip gitea resolving
  if ((options.token ?? '') === '')
    return info

  // A commit names its author's account exactly, so only an author with no commit of their own, a co-author, is searched by email.
  if (info.commits.length) {
    try {
      const data = await api<GiteaCommit>(`https://${options.baseUrlApi}/repos/${options.repo}/${onGithub(options) ? 'commits' : 'git/commits'}/${info.commits[0]}`, {
        headers: getHeaders(options),
      })

      if (data.author !== null) {
        info.login = data.author.login
        info.avatar = data.author.avatar_url
      }
    }
    catch {}
  }

  // GitHub's user search shows no email to match exactly, so a co-author stays a name there.
  if ((info.login ?? '') !== '' || onGithub(options))
    return info

  try {
    // Forgejo matches the keyword inside a public email only, so the account whose email is exactly this one is picked.
    const data = await api<{ data: { login: string, email: string, avatar_url?: string }[] }>(`https://${options.baseUrlApi}/users/search?q=${encodeURIComponent(info.email)}`, {
      headers: getHeaders(options),
    })

    const user = data.data.find(user => user.email.toLowerCase() === info.email.toLowerCase())

    if (user !== undefined) {
      info.login = user.login

      if (user.avatar_url !== undefined)
        info.avatar = user.avatar_url
    }
  }
  catch {}

  return info
}

export async function resolveAuthors(commits: Commit[], options: ChangelogOptions) {
  const map = new Map<string, AuthorInfo>()

  for (const commit of commits) {
    for (const [idx, author] of commit.authors.entries()) {
      if (!author.email || !author.name || excludeAuthors.some(re => re.test(author.name)))
        continue

      if (!map.has(author.email))
        map.set(author.email, { commits: [], name: author.name, email: author.email })

      // record commits only for the first author
      if (idx === 0)
        map.get(author.email)!.commits.push(commit.shortHash)
    }
  }

  const authors = Array.from(map.values())
  const resolved = await Promise.all(authors.map(async info => resolveAuthorInfo(options, info)))

  const loginSet = new Set<string>()
  const nameSet = new Set<string>()

  return resolved
    .sort((a, b) => (a.login ?? a.name).localeCompare(b.login ?? b.name))
    .filter((i) => {
      if (i.login !== undefined && loginSet.has(i.login))
        return false

      if (i.login !== undefined) {
        loginSet.add(i.login)
      }
      else {
        if (nameSet.has(i.name))
          return false

        nameSet.add(i.name)
      }

      return true
    })
}

export async function hasTagOnGitea(tag: string, options: ChangelogOptions) {
  try {
    const url = `https://${options.baseUrlApi}/${tagPath(options, options.repo, tag)}`

    console.log(`checking if tag exists on ${url}`)
    await api(url, {
      headers: getHeaders(options),
    })

    return true
  }
  catch {
    return false
  }
}

// Returns how many assets could not be uploaded.
export async function uploadAssets(options: ChangelogOptions, assets: string | string[]): Promise<number> {
  const headers = getHeaders(options)
  let assetList: string[] = []

  if (typeof assets === 'string') {
    assetList = assets.split(',').map(s => s.trim()).filter(Boolean)
  }
  else if (Array.isArray(assets)) {
    assetList = assets.flatMap(item =>
      typeof item === 'string' ? item.split(',').map(s => s.trim()) : [],
    ).filter(Boolean)
  }

  // Expand glob patterns to actual file paths
  const expandedAssets: string[] = []

  for (const pattern of assetList) {
    try {
      // Use the pattern directly without shell expansion
      const glob = new Bun.Glob(pattern)
      const matches = Array.from(glob.scanSync())

      if (matches.length) {
        expandedAssets.push(...matches)
      }
      else {
        // If no matches found, treat as literal path
        expandedAssets.push(pattern)
      }
    }
    catch (error) {
      writeErr(err().red(`Failed to process glob pattern "${pattern}": ${String(error)}`))
      // Keep the original pattern as fallback
      expandedAssets.push(pattern)
    }
  }

  // Get the release by tag to obtain its id
  const release = await api<GiteaRelease>(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/tags/${encodeURIComponent(options.to ?? '')}`, {
    headers,
  })
  let failed = 0

  for (const asset of expandedAssets) {
    const filePath = path.resolve(asset)
    const file = Bun.file(filePath)

    if (!await file.exists()) {
      writeErr(err().red(`Failed to read file ${filePath}: file does not exist`))
      failed++

      continue
    }

    const fileName = path.basename(filePath)
    const assetsPath = `repos/${options.releaseRepo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`

    console.log(out().cyan(`Uploading ${fileName}...`))

    try {
      if (onGithub(options)) {
        await request(`https://uploads.github.com/${assetsPath}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: file })
      }
      else {
        // Forgejo expects multipart/form-data with an `attachment` field
        const form = new FormData()

        form.append('attachment', file, fileName)
        await request(`https://${options.baseUrlApi}/${assetsPath}`, { method: 'POST', headers, body: form })
      }

      console.log(out().green(`Uploaded ${fileName} successfully.`))
    }
    catch (error) {
      writeErr(err().red(`Failed to upload ${fileName}: ${String(error)}`))
      failed++
    }
  }

  return failed
}
