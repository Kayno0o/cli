import type { ChangelogConfig } from '../src/changelog'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { expect, it } from 'bun:test'
import { getGitDiff, parseGitCommit } from '../src/changelog'
import { inside } from './fixture'

const tempDir = tempDirs()
const config = { scopeMap: {} } as ChangelogConfig

async function repo() {
  const dir = tempDir('changelog-commits-')
  const git = async (...args: string[]) => (await $`git -c commit.gpgsign=false -c user.name=Ada -c user.email=ada@example.com ${args}`.cwd(dir).quiet().text()).trim()

  await git('init', '-b', 'main')

  return {
    dir,
    git,
    commit: async (message: string) => {
      await git('commit', '--allow-empty', '-m', message)

      return git('rev-parse', 'HEAD')
    },
  }
}

function parsed(message: string, body = '') {
  return parseGitCommit({ message, body, shortHash: 'abc1234', author: { name: 'Ada', email: 'ada@example.com' } }, config)
}

it('lists only the commits between from and to when from is not an ancestor of to', async () => {
  const { dir, git, commit } = await repo()

  await commit('chore: base')
  await git('checkout', '-b', 'side')
  await commit('fix: only on side')
  const from = await git('rev-parse', 'HEAD')

  await git('checkout', 'main')
  await commit('feat: only on main')

  const commits = await inside(dir, async () => getGitDiff(from, 'main'))

  expect(commits.map(c => c.message)).toEqual(['feat: only on main'])
})

it('keeps a subject, an author name and a body containing pipes or rules in one commit', async () => {
  const { dir, commit } = await repo()

  await commit('feat: a | b | c')
  await commit('fix: second\n\nsome text\n----\nmore text')

  const commits = await inside(dir, async () => getGitDiff(undefined, 'HEAD'))

  expect(commits.map(c => c.message)).toEqual(['fix: second', 'feat: a | b | c'])
  expect(commits[0]!.body).toContain('more text')
  expect(commits[1]).toMatchObject({ author: { name: 'Ada', email: 'ada@example.com' } })
  expect(commits[1]!.shortHash).toMatch(/^[0-9a-f]+$/)
})

it('reads the type at the start of the subject only', () => {
  expect(parsed('Revert "feat: x"')).toBeNull()
  expect(parsed('see fix: y')).toBeNull()
})

it('ends the scope at its first closing parenthesis', () => {
  expect(parsed('fix(api): handle (x): y')).toMatchObject({ type: 'fix', scope: 'api', description: 'handle (x): y' })
})

it('reads a breaking change from a BREAKING CHANGE or BREAKING-CHANGE footer line only', () => {
  expect(parsed('feat: x', 'BREAKING CHANGE: gone')?.isBreaking).toBe(true)
  expect(parsed('feat: x', 'text\nBREAKING-CHANGE: gone')?.isBreaking).toBe(true)
  expect(parsed('feat: x', 'this is not a breaking change: really')?.isBreaking).toBe(false)
})
