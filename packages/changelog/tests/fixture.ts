import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { $ } from 'bun'

export interface ReleasedRepo {
  dir: string
  from: string
  to: string
}

// Turns the empty dir into a repo cut at v1.2.0, v1.2.2, v1.3.0, v1.4.0, v1.4.1 and v1.4.2, then a fix, a refactor and a ci commit by Kaynooo after the last tag, with a Forgejo origin.
export async function releasedRepo(dir: string): Promise<ReleasedRepo> {
  const git = async (...args: string[]) => $`git ${args}`.cwd(dir).quiet()
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Kaynooo', GIT_AUTHOR_EMAIL: 'kaynooo@example.com', GIT_COMMITTER_NAME: 'Kaynooo', GIT_COMMITTER_EMAIL: 'kaynooo@example.com' }
  let day = 0
  const commit = async (message: string) => {
    const date = `2024-01-${String(++day).padStart(2, '0')}T00:00:00Z`

    await writeFile(join(dir, 'log.txt'), `${message}\n`, { flag: 'a' })
    await git('add', 'log.txt')
    await $`git -c commit.gpgsign=false commit -m ${message}`.cwd(dir).env({ ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }).quiet()
  }

  await git('init', '-b', 'main')
  await git('remote', 'add', 'origin', 'git@git.kaynooo.fr:kaynooo/cli.git')

  for (const version of ['1.2.0', '1.2.2', '1.3.0', '1.4.0', '1.4.1', '1.4.2']) {
    await commit(`chore: release v${version}`)
    await git('tag', `v${version}`)
  }

  await commit('fix: upload to forgejo using bun')
  await commit('refactor: remove deps execa and node')
  await commit('ci: use bun')

  const sha = async (ref: string) => (await $`git rev-parse ${ref}`.cwd(dir).text()).trim()

  return { dir, from: await sha('v1.4.2'), to: await sha('HEAD') }
}

// Runs fn with the working directory moved to dir, as the changelog reads git and its config from there.
export async function inside<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const cwd = process.cwd()

  process.chdir(dir)

  try {
    return await fn()
  }
  finally {
    process.chdir(cwd)
  }
}
