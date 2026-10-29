import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { cwdGone, git, leaveWorktree } from '../src/git'
import { refreshed } from '../src/runs'
import { withFakeTea } from './fake-tea'

describe('a wait whose working directory is deleted', () => {
  test('moves from a linked worktree to the main checkout, and names a removed working directory', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ft-cwd-')))
    const main = join(root, 'main')
    const linked = join(root, 'linked')
    const home = process.cwd()

    try {
      await $`git init -q -b main ${main} && git -C ${main} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && git -C ${main} worktree add -q ${linked}`.quiet()
      process.chdir(linked)
      await leaveWorktree()
      expect(process.cwd()).toBe(main)

      process.chdir(linked)
      await rm(linked, { recursive: true })
      expect(cwdGone()).toBe(true)
      expect(git(['status'])).rejects.toThrow('the working directory was removed')
    }
    finally {
      process.chdir(home)
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('refreshed', () => {
  test('reads the runs as they stand now, or nothing when one cannot be read', async () => {
    const run = (id: number, status: string) => ({ id, status })
    const stale = [run(1, 'running'), run(2, 'running')] as never

    await withFakeTea({ issues: [], runs: [run(1, 'success'), run(2, 'failure')] }, async () => {
      expect((await refreshed(stale))?.map(found => found.status)).toEqual(['success', 'failure'])
    })

    await withFakeTea({ issues: [], runs: [run(1, 'success')] }, async () => {
      expect(await refreshed(stale)).toBeUndefined()
    })
  })
})
