import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { fetchBranch, resolveCommit } from '../src/git'
import { refusal } from './fake-tea'

async function inClone(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ft-inject-')))
  const clone = join(root, 'clone')
  const home = process.cwd()

  try {
    await $`git init -q --bare -b main ${join(root, 'origin.git')} && git clone -q ${join(root, 'origin.git')} ${clone}`.cwd(root).quiet()
    process.chdir(clone)
    await $`git config user.name t && git config user.email t@t && git commit -q --allow-empty -m one && git push -q origin main`.cwd(clone).quiet()
    await run(root)
  }
  finally {
    process.chdir(home)
    await rm(root, { recursive: true, force: true })
  }
}

describe('fetchBranch', () => {
  test('fetches a branch, and refuses a name git would read as an option', async () => {
    await inClone(async (root) => {
      const marker = join(root, 'pwned')

      await fetchBranch('main')

      for (const name of [`--upload-pack=touch ${marker}`, '-b', 'a..b', 'with space'])
        expect(await refusal(fetchBranch(name))).toContain('is not a branch name')

      expect(await Bun.file(marker).exists()).toBe(false)
    })
  })
})

describe('resolveCommit', () => {
  test('resolves a revision, and reads a value starting with a dash as a revision, never an option', async () => {
    await inClone(async () => {
      expect(await resolveCommit('HEAD')).toMatch(/^[0-9a-f]{40}$/)
      expect(await refusal(resolveCommit('--help'))).toBe('no commit --help')
      expect(await refusal(resolveCommit('--output=out.txt'))).toBe('no commit --output=out.txt')
    })
  })
})
