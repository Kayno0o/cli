import type { ChangelogOptions } from './types'
import { parseSemver, validateSemver } from '@kaynooo/utils'
import { $ } from 'bun'

const gitSuffixRE = /\.git$/
const sshRegex = /(?:ssh:\/\/[^/]+\/|^(?:[^@/\s]+@)?[^:/\s]+:)(\w[\w.-]+)\/(\w[\w.-]+)$/i
const regexSpecialRE = /[.*+?^${}()|[\]\\]/g
const httpsRegex = /https?:\/\/[^/]+\/(\w[\w.-]+)\/(\w[\w.-]+)$/i
const releaseVersionRE = /^[^.]*(?:\.[\d.]*|\d)$/

export async function getGiteaRepo() {
  const url = await execCommand('git', ['config', '--get', 'remote.origin.url'])
  const cleanUrl = url.replace(gitSuffixRE, '')

  let match = sshRegex.exec(cleanUrl)

  match ||= httpsRegex.exec(cleanUrl)

  if (!match)
    throw new Error(`Can not parse Gitea repo from url ${url}`)

  return `${match[1]}/${match[2]}`
}

export async function getCurrentGitBranch() {
  const [tag] = (await execCommand('git', ['tag', '--points-at', 'HEAD', '--sort=-v:refname'])).split('\n')

  return tag !== undefined && tag !== '' ? tag : await execCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
}

export async function isRepoShallow() {
  return (await execCommand('git', ['rev-parse', '--is-shallow-repository'])).trim() === 'true'
}

export function getSafeTagTemplate(template: string) {
  return template.includes('%s') ? template : `${template}%s`
}

export function getVersionString(template: string, tag: string): string {
  const pattern = template.split('%s').map(part => part.replace(regexSpecialRE, '\\$&')).join('(.+)')
  const regex = new RegExp(`^${pattern}$`)
  const match = regex.exec(tag)

  return match?.[1] ?? tag
}

export async function getGitTags(firstParent = false) {
  const output = await execCommand('git', [
    'log',
    ...firstParent ? ['--first-parent'] : [],
    '--simplify-by-decoration',
    '--pretty=format:"%d"',
  ])

  const tagRegex = /tag: ([^,)]+)/g
  const tagList: string[] = []
  let match

  while (match !== null) {
    const tag = match?.[1]?.trim()

    if (tag !== undefined && tag !== '') {
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
  rollup: NonNullable<ChangelogOptions['rollup']> = {},
  firstParent = false,
) {
  const inputVersionString = getVersionString(tagTemplate, inputTag)
  // `validateSemver` only accepts stable `x.y.z` versions, so it doubles as a
  // "is a stable (non-prerelease) version" check.
  const isStableVersion = validateSemver(inputVersionString)
  const tags = await getGitTags(firstParent)
  const filteredTags = tags.filter(tagFilter)

  let tag: string | undefined

  // Doing a stable release, find the last stable release to compare with
  if (isStableVersion) {
    const input = parseSemver(inputVersionString)
    const isMajor = input.minor === 0 && input.patch === 0
    const isMinor = !isMajor && input.patch === 0

    // On a rolled-up minor/major release, walk back to the previous minor/major
    // tag so the range absorbs every intermediate patch (and minor) release.
    let boundary: ((v: { minor: number, patch: number }) => boolean) | undefined

    if (isMajor && rollup.major)
      boundary = v => v.minor === 0 && v.patch === 0
    else if (isMinor && rollup.minor)
      boundary = v => v.patch === 0

    tag = filteredTags.find((tag) => {
      const versionString = getVersionString(tagTemplate, tag)

      if (versionString === inputVersionString || !validateSemver(versionString))
        return false

      return boundary ? boundary(parseSemver(versionString)) : true
    })
  }

  // Fallback to the last tag, that are not the input tag
  tag ||= filteredTags.find(tag => tag !== inputTag)

  return tag
}

export async function isRefGitTag(to: string) {
  const ref = `refs/tags/${to}`

  try {
    await $`git show-ref --verify ${ref}`.quiet()

    return true
  }
  catch {
    return false
  }
}

export async function getFirstGitCommit(firstParent = false) {
  return (await execCommand('git', ['rev-list', '--max-parents=0', ...firstParent ? ['--first-parent'] : [], 'HEAD'])).split('\n').at(-1) ?? ''
}

export async function deleteLocalTag(tag: string) {
  await $`git tag -d ${tag}`.quiet()
}

export async function hasRemoteGitTag(tag: string, remote = 'origin') {
  return (await execCommand('git', ['ls-remote', '--tags', remote, `refs/tags/${tag}`])).length > 0
}

export async function deleteRemoteGitTag(tag: string, remote = 'origin') {
  await $`git push ${remote} --delete ${tag}`.quiet()
}

export async function getTagCommit(tag: string) {
  return execCommand('git', ['rev-list', '-n', '1', tag])
}

export async function getHeadCommit() {
  return execCommand('git', ['rev-parse', 'HEAD'])
}

export async function getCommitSubject(ref: string) {
  return execCommand('git', ['log', '-1', '--format=%s', ref])
}

export async function softResetLastCommit() {
  await $`git reset --soft HEAD~1`.quiet()
}

export function isPrerelease(version: string) {
  return !releaseVersionRE.test(version)
}

async function execCommand(cmd: string, args: string[]) {
  return (await $`${cmd} ${args}`.quiet().text()).trim()
}
