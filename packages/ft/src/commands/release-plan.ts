import type { Manifest } from './release-version'
import { basename, join, relative } from 'node:path'
import process from 'node:process'
import { fail, formatDuration } from '@kaynooo/cli-kit'
import { gitOk, tagsAt } from '../git'
import { nextVersion, taggedVersion } from './release-version'

interface Plan {
  level: string | undefined
  dir: string | undefined
  prefix: string
  branch: string
  base: string
  timeout: number
  registry: boolean
}

// What a release would do, step by step, once it passed the same checks a real run makes.
export async function printPlan({ level, dir, prefix, branch, base, timeout, registry }: Plan): Promise<number> {
  const file = Bun.file(join(dir ?? '.', 'package.json'))
  const pkg = await file.exists() ? await file.json() as Manifest : undefined
  const name = pkg?.name ?? basename(dir ?? process.cwd())
  const where = dir === undefined ? '' : ` in ${relative(process.cwd(), dir) || '.'}`
  const sha = base.slice(0, 7)
  let version: string
  let bump: string

  if (level === undefined) {
    const tag = (await tagsAt('HEAD')).find(each => taggedVersion(each, prefix) !== undefined)

    if (tag === undefined)
      fail(`HEAD carries no ${prefix}* tag`)

    version = tag.slice(prefix.length)
    bump = `take the version commit at HEAD, tagged ${tag}`
    console.log(`would release ${name} ${version}, tagged ${tag}`)
  }
  else {
    if (pkg?.version === undefined)
      fail(`no version in ${join(dir ?? '.', 'package.json')}`)

    version = nextVersion(pkg.version, level)
    bump = dir === undefined ? `bun pm version ${level}, which commits and tags ${prefix}${version}` : `bun pm version ${level} --no-git-tag-version${where}, then commit it with bun.lock refreshed and tag ${prefix}${version}`
    console.log(`would release ${name} ${pkg.version} -> ${version}, tagged ${prefix}${version}`)
  }

  const pushed = await gitOk(['merge-base', '--is-ancestor', base, `origin/${branch}`])
  const registryStep = registry && pkg?.name !== undefined && pkg.private !== true ? `wait for the registry to serve ${pkg.name}@${version}` : `skip the registry: ${registry ? 'the package is private or unnamed' : '--no-registry'}`
  const steps = [
    pushed ? `wait for the runs on ${sha}, already on origin/${branch}` : `push ${branch} at ${sha}, which origin lacks, then wait for its runs`,
    bump,
    `push ${branch} and ${prefix}${version} in one atomic push, then wait for the runs it starts (${formatDuration(timeout)} at most)`,
    registryStep,
  ]

  console.log(steps.map((step, i) => `  ${i + 1}. ${step}`).join('\n'))
  console.log('dry run: nothing was pushed, committed or tagged')

  return 0
}
