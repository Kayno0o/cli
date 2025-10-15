import semver from 'semver'

export async function getGiteaRepo() {
  const url = await execCommand('git', ['config', '--get', 'remote.origin.url'])
  const cleanUrl = url.replace(/\.git$/, '')

  const sshRegex = /(?:ssh:\/\/[^/]+\/|git@[^:]+:)(\w[\w.-]+)\/(\w[\w.-]+)$/i
  let match = sshRegex.exec(cleanUrl)

  if (!match) {
    const httpsRegex = /https?:\/\/[^/]+\/(\w[\w.-]+)\/(\w[\w.-]+)$/i

    match = httpsRegex.exec(cleanUrl)
  }

  if (!match)
    throw new Error(`Can not parse Gitea repo from url ${url}`)

  return `${match[1]}/${match[2]}`
}

export async function getCurrentGitBranch() {
  return await execCommand('git', ['tag', '--points-at', 'HEAD']) || await execCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
}

export async function isRepoShallow() {
  return (await execCommand('git', ['rev-parse', '--is-shallow-repository'])).trim() === 'true'
}

export function getSafeTagTemplate(template: string) {
  return template.includes('%s') ? template : `${template}%s`
}

function getVersionString(template: string, tag: string) {
  const pattern = template.replace(/%s/g, '(.+)')
  const regex = new RegExp(`^${pattern}$`)
  const match = regex.exec(tag)

  return match ? match[1] : tag
}

export async function getGitTags() {
  const output = await execCommand('git', [
    'log',
    '--simplify-by-decoration',
    '--pretty=format:"%d"',
  ])

  const tagRegex = /tag: ([^,)]+)/g
  const tagList: string[] = []
  let match

  while (match !== null) {
    const tag = match?.[1].trim()

    if (tag) {
      tagList.push(tag)
    }

    match = tagRegex.exec(output)
  }

  return tagList
}

export async function getLastMatchingTag(
  inputTag: string,
  tagFilter: (tag: string) => boolean,
  tagTemplate: string,
) {
  const inputVersionString = getVersionString(tagTemplate, inputTag)
  const isVersion = semver.valid(inputVersionString) !== null
  const isPrerelease = semver.prerelease(inputVersionString) !== null
  const tags = await getGitTags()
  const filteredTags = tags.filter(tagFilter)

  let tag: string | undefined

  // Doing a stable release, find the last stable release to compare with
  if (!isPrerelease && isVersion) {
    tag = filteredTags.find((tag) => {
      const versionString = getVersionString(tagTemplate, tag)

      return versionString !== inputVersionString
        && semver.valid(versionString) !== null
        && semver.prerelease(versionString) === null
    })
  }

  // Fallback to the last tag, that are not the input tag
  tag ||= filteredTags.find(tag => tag !== inputTag)

  return tag
}

export async function isRefGitTag(to: string) {
  const { execa } = await import('execa')

  try {
    await execa('git', ['show-ref', '--verify', `refs/tags/${to}`], { reject: true })

    return true
  }
  catch {
    return false
  }
}

export async function getFirstGitCommit() {
  return execCommand('git', ['rev-list', '--max-parents=0', 'HEAD'])
}

export function isPrerelease(version: string) {
  return !(/^[^.]*(?:\.[\d.]*|\d)$/).test(version)
}

async function execCommand(cmd: string, args: string[]) {
  const { execa } = await import('execa')
  const res = await execa(cmd, args)

  return res.stdout.trim()
}
