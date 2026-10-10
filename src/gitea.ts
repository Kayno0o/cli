import type { AuthorInfo, ChangelogOptions, Commit } from './types'
import path from 'node:path'
import { colors, notNullish } from '@kaynooo/utils'

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)

  if (!res.ok)
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`)

  return res.json() as Promise<T>
}

export async function sendRelease(
  options: ChangelogOptions,
  content: string,
) {
  const headers = getHeaders(options)
  let url = `https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases`
  let method = 'POST'

  try {
    const exists = await api(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/tags/${options.to}`, {
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
    name: options.name || options.to,
    prerelease: options.prerelease,
    tag_name: options.to,
  }

  console.log(colors.cyan(method === 'POST'
    ? 'Creating release notes...'
    : 'Updating release notes...'),
  )
  const res = await api(url, {
    method,
    body: JSON.stringify(body),
    headers: { ...headers, 'content-type': 'application/json' },
  })

  console.log(colors.green(`Released on ${res.html_url}`))
}

export async function getRelease(options: ChangelogOptions, tag: string) {
  try {
    return await api(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/tags/${tag}`, {
      headers: getHeaders(options),
    })
  }
  catch {
    return null
  }
}

export async function deleteRelease(options: ChangelogOptions, releaseId: number) {
  const res = await fetch(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/${releaseId}`, {
    method: 'DELETE',
    headers: getHeaders(options),
  })

  if (!res.ok)
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`)
}

export async function hasRemoteTag(options: ChangelogOptions, tag: string) {
  try {
    await api(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/tags/${tag}`, {
      headers: getHeaders(options),
    })

    return true
  }
  catch {
    return false
  }
}

export async function deleteRemoteTag(options: ChangelogOptions, tag: string) {
  const res = await fetch(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/tags/${tag}`, {
    method: 'DELETE',
    headers: getHeaders(options),
  })

  if (!res.ok)
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`)
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
  if (info.login)
    return info

  // token not provided, skip gitea resolving
  if (!options.token)
    return info

  // A commit names its author's account exactly, so only an author with no commit of their own, a co-author, is searched by email.
  if (info.commits.length) {
    try {
      const data = await api(`https://${options.baseUrlApi}/repos/${options.repo}/commits/${info.commits[0]}`, {
        headers: getHeaders(options),
      })

      info.login = data.author.login
    }
    catch {}
  }

  if (info.login)
    return info

  try {
    // Forgejo matches the keyword inside a public email only, so the account whose email is exactly this one is picked.
    const data = await api<{ data: { login: string, email: string }[] }>(`https://${options.baseUrlApi}/users/search?q=${encodeURIComponent(info.email)}`, {
      headers: getHeaders(options),
    })

    info.login = data.data.find(user => user.email.toLowerCase() === info.email.toLowerCase())?.login
  }
  catch {}

  return info
}

export async function resolveAuthors(commits: Commit[], options: ChangelogOptions) {
  const map = new Map<string, AuthorInfo>()

  for (const commit of commits) {
    commit.resolvedAuthors = commit.authors.map((a, idx) => {
      if (!a.email || !a.name)
        return null

      if (excludeAuthors.some(re => re.test(a.name)))
        return null

      if (!map.has(a.email)) {
        map.set(a.email, {
          commits: [],
          name: a.name,
          email: a.email,
        })
      }

      const info = map.get(a.email)!

      // record commits only for the first author
      if (idx === 0)
        info.commits.push(commit.shortHash)

      return info
    }).filter(notNullish)
  }

  const authors = Array.from(map.values())
  const resolved = await Promise.all(authors.map(async info => resolveAuthorInfo(options, info)))

  const loginSet = new Set<string>()
  const nameSet = new Set<string>()

  return resolved
    .sort((a, b) => (a.login || a.name).localeCompare(b.login || b.name))
    .filter((i) => {
      if (i.login && loginSet.has(i.login))
        return false

      if (i.login) {
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
    console.log(`checking if tag exists on https://${options.baseUrlApi}/repos/${options.repo}/tags/${tag}`)
    await api(`https://${options.baseUrlApi}/repos/${options.repo}/tags/${tag}`, {
      headers: getHeaders(options),
    })

    return true
  }
  catch {
    return false
  }
}

export async function uploadAssets(options: ChangelogOptions, assets: string | string[]) {
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
      console.error(colors.red(`Failed to process glob pattern "${pattern}": ${error}`))
      // Keep the original pattern as fallback
      expandedAssets.push(pattern)
    }
  }

  // Get the release by tag to obtain its id
  const release = await api(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/tags/${options.to}`, {
    headers,
  })

  for (const asset of expandedAssets) {
    const filePath = path.resolve(asset)
    const file = Bun.file(filePath)

    if (!await file.exists()) {
      console.error(colors.red(`Failed to read file ${filePath}: file does not exist`))

      continue
    }

    const fileName = path.basename(filePath)

    // Gitea expects multipart/form-data with an `attachment` field
    const form = new FormData()

    form.append('attachment', file, fileName)

    const uploadUrl = `https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`

    console.log(colors.cyan(`Uploading ${fileName}...`))

    try {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers,
        body: form,
      })

      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`)
      }

      console.log(colors.green(`Uploaded ${fileName} successfully.`))
    }
    catch (error) {
      console.error(colors.red(`Failed to upload ${fileName}: ${error}`))
    }
  }
}
