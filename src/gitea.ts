import type { AuthorInfo, ChangelogOptions, Commit } from './types'
import fs from 'node:fs/promises'
import path from 'node:path'
import { colors, notNullish } from '@kaynooo/utils'

import { $fetch } from 'ofetch'

export async function sendRelease(
  options: ChangelogOptions,
  content: string,
) {
  const headers = getHeaders(options)
  let url = `https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases`
  let method = 'POST'

  try {
    const exists = await $fetch(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/tags/${options.to}`, {
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
  const res = await $fetch(url, {
    method,
    body: JSON.stringify(body),
    headers,
  })

  console.log(colors.green(`Released on ${res.html_url}`))
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

  try {
    // https://docs.git.kaynooo.fr/en/search-gitea/searching-on-gitea/searching-users#search-only-users-or-organizations
    const q = encodeURIComponent(`${info.email} type:user in:email`)
    const data = await $fetch(`https://${options.baseUrlApi}/search/users?q=${q}`, {
      headers: getHeaders(options),
    })

    info.login = data.items[0].login
  }
  catch {}

  if (info.login)
    return info

  if (info.commits.length) {
    try {
      const data = await $fetch(`https://${options.baseUrlApi}/repos/${options.repo}/commits/${info.commits[0]}`, {
        headers: getHeaders(options),
      })

      info.login = data.author.login
    }
    catch {}
  }

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
    await $fetch(`https://${options.baseUrlApi}/repos/${options.repo}/tags/${tag}`, {
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
  const release = await $fetch(`https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/tags/${options.to}`, {
    headers,
  })

  for (const asset of expandedAssets) {
    const filePath = path.resolve(asset)

    try {
      const fileData = await fs.readFile(filePath)
      const fileName = path.basename(filePath)

      // Gitea expects multipart/form-data with an `attachment` field
      const form = new FormData()
      form.append('attachment', new Blob([fileData]), fileName)

      const uploadUrl = `https://${options.baseUrlApi}/repos/${options.releaseRepo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`

      console.log(colors.cyan(`Uploading ${fileName}...`))

      try {
        await $fetch(uploadUrl, {
          method: 'POST',
          headers,
          body: form,
        })
        console.log(colors.green(`Uploaded ${fileName} successfully.`))
      }
      catch (error) {
        console.error(colors.red(`Failed to upload ${fileName}: ${error}`))
      }
    }
    catch (error) {
      console.error(colors.red(`Failed to read file ${filePath}: ${error}`))
    }
  }
}
