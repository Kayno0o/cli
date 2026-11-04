import type { AuthorInfo, ChangelogOptions, Commit } from './types'
import path from 'node:path'
import { err, out } from './ui'

const REQUEST_MS = 60_000

interface GiteaRelease {
  id: number
  name: string
  url: string
  html_url: string
}

interface GiteaCommit {
  author: { login: string, avatar_url: string }
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
}

export async function getRelease(options: ChangelogOptions, tag: string) {
  try {
    return await api<GiteaRelease>(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: getHeaders(options),
    })
  }
  catch {
    return null
  }
}

export async function deleteRelease(options: ChangelogOptions, releaseId: number) {
  await request(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/${releaseId}`, {
    method: 'DELETE',
    headers: getHeaders(options),
  })
}

export async function hasRemoteTag(options: ChangelogOptions, tag: string) {
  try {
    await api(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/tags/${encodeURIComponent(tag)}`, {
      headers: getHeaders(options),
    })

    return true
  }
  catch {
    return false
  }
}

export async function deleteRemoteTag(options: ChangelogOptions, tag: string) {
  await request(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/tags/${encodeURIComponent(tag)}`, {
    method: 'DELETE',
    headers: getHeaders(options),
  })
}

function getHeaders(options: ChangelogOptions) {
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
  if ((info.login ?? '') !== '')
    return info

  // token not provided, skip gitea resolving
  if ((options.token ?? '') === '')
    return info

  // A commit names its author's account exactly, so only an author with no commit of their own, a co-author, is searched by email.
  if (info.commits.length) {
    try {
      const data = await api<GiteaCommit>(`https://${options.baseUrlApi}/repos/${options.repo}/git/commits/${info.commits[0]}`, {
        headers: getHeaders(options),
      })

      info.login = data.author.login
      info.avatar = data.author.avatar_url
    }
    catch {}
  }

  if ((info.login ?? '') !== '')
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
    console.log(`checking if tag exists on https://${options.baseUrlApi}/repos/${options.repo}/tags/${encodeURIComponent(tag)}`)
    await api(`https://${options.baseUrlApi}/repos/${options.repo}/tags/${encodeURIComponent(tag)}`, {
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
      console.error(err().red(`Failed to process glob pattern "${pattern}": ${String(error)}`))
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
      console.error(err().red(`Failed to read file ${filePath}: file does not exist`))
      failed++

      continue
    }

    const fileName = path.basename(filePath)

    // Gitea expects multipart/form-data with an `attachment` field
    const form = new FormData()

    form.append('attachment', file, fileName)

    const uploadUrl = `https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`

    console.log(out().cyan(`Uploading ${fileName}...`))

    try {
      await request(uploadUrl, { method: 'POST', headers, body: form })
      console.log(out().green(`Uploaded ${fileName} successfully.`))
    }
    catch (error) {
      console.error(err().red(`Failed to upload ${fileName}: ${String(error)}`))
      failed++
    }
  }

  return failed
}
