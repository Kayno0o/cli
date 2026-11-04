import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { expect, it } from 'bun:test'
import { getGitDiff } from '../src/changelog'
import { generate } from '../src/generate'
import { getFirstGitCommit } from '../src/git'
import { inside } from './fixture'

const tempDir = tempDirs()

// Main has a root, an optional v1.0.0 tag, then a merge of an unrelated history (carrying a later-dated, unprefixed 9.5.0 tag when tagged), then one more commit.
async function mergedRepo(tagged: boolean) {
  const dir = tempDir('changelog-first-parent-')
  const git = async (...args: string[]) => $`git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false ${args}`.cwd(dir).quiet()
  const commit = async (file: string, message: string, date: string) => {
    await writeFile(join(dir, file), message)
    await git('add', file)
    await $`git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -m ${message}`.cwd(dir).env({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }).quiet()
  }

  await git('init', '-b', 'main')
  await commit('a.txt', 'feat: main root', '2020-01-01T00:00:00Z')

  if (tagged)
    await git('tag', 'v1.0.0')

  await commit('b.txt', 'feat: after tag', '2020-01-02T00:00:00Z')
  await git('checkout', '--orphan', 'other')
  await git('rm', '-rf', '.')
  await commit('c.txt', 'feat: imported one', '2021-01-01T00:00:00Z')
  await commit('d.txt', 'feat: imported two', '2021-01-02T00:00:00Z')

  if (tagged)
    await git('tag', '9.5.0')

  await git('checkout', 'main')
  await git('merge', '--allow-unrelated-histories', '--no-ff', '-m', 'feat: merge other', 'other')
  await commit('e.txt', 'feat: after merge', '2022-01-01T00:00:00Z')

  return dir
}

it('lists a merge on its own with firstParent, and its imported commits without', async () => {
  const dir = await mergedRepo(false)

  await inside(dir, async () => {
    const messages = async (firstParent: boolean) => (await getGitDiff(undefined, 'HEAD', firstParent)).map(c => c.message)
    const flat = await messages(true)
    const all = await messages(false)

    expect(flat).toContain('feat: merge other')
    expect(flat).not.toContain('feat: imported one')
    expect(all).toContain('feat: imported one')
    expect(all).toContain('feat: imported two')
  })
})

it('generates from a tag before the merge with only first-parent commits', async () => {
  const dir = await mergedRepo(true)

  await inside(dir, async () => {
    const { commits } = await generate({ firstParent: true, from: 'v1.0.0', to: 'HEAD', contributors: false, repo: 'o/r' })
    const descriptions = commits.map(c => c.description)

    expect(['merge other', 'after merge', 'after tag'].filter(wanted => !descriptions.includes(wanted))).toEqual([])
    expect(descriptions).not.toContain('imported one')
    expect(descriptions).not.toContain('imported two')
  })
})

it('finds the starting tag along the first parent, ignoring a later imported tag', async () => {
  const dir = await mergedRepo(true)

  await inside(dir, async () => {
    const options = { to: 'HEAD', contributors: false, repo: 'o/r' }

    expect((await generate({ ...options, firstParent: true })).config.from).toBe('v1.0.0')
    expect((await generate({ ...options, firstParent: false })).config.from).toBe('9.5.0')
  })
})

it('starts from a single root when no tag exists and the history was merged', async () => {
  const dir = await mergedRepo(false)

  await inside(dir, async () => {
    const options = { to: 'HEAD', contributors: false, repo: 'o/r' }
    const { config } = await generate({ ...options, firstParent: true })

    expect(config.from).toMatch(/^[0-9a-f]{40}$/)
    expect(await getFirstGitCommit()).toMatch(/^[0-9a-f]{40}$/)
  })
})
