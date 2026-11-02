import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { capture } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { release } from '../src/commands/release'
import { timing } from '../src/commands/watch'
import { withFakeTea } from './fake-tea'

// A clone whose origin refuses every tag, with an unpushed `feat` commit.
async function refusingTags(run: (sha: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ft-release-'))
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const hook = join(origin, 'hooks', 'pre-receive')
  const home = process.cwd()
  const poll = timing.poll

  try {
    await $`git init -q --bare -b main ${origin} && git clone -q ${origin} ${work}`.quiet()
    process.chdir(work)
    await Bun.write(join(work, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
    await $`git config user.name t && git config user.email t@t && git add package.json && git commit -q -m init && git push -q origin main`.quiet()
    await Bun.write(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/tags/*) echo "no tags here" >&2; exit 1;; esac; done\n')
    await chmod(hook, 0o755)
    await Bun.write(join(work, 'a.ts'), 'export {}\n')
    await $`git add a.ts && git commit -q -m feat`.quiet()
    timing.poll = 1
    await run((await $`git rev-parse HEAD`.text()).trim())
  }
  finally {
    timing.poll = poll
    process.chdir(home)
    await rm(root, { recursive: true, force: true })
  }
}

const passing = (sha: string) => [{ id: 7, commit_sha: sha, event: 'push', status: 'success', workflow_id: 'test.yml', prettyref: 'main', html_url: 'https://forge/runs/7', title: 'feat' }]

describe('release rollback', () => {
  test('a refused push drops the bump commit and its tag, back to the commit it started on', async () => {
    await refusingTags(async (sha) => {
      await withFakeTea({ issues: [], runs: passing(sha) }, async () => {
        // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
        await expect(capture(async () => release(['patch']))).rejects.toThrow('origin refused the push')
      })

      expect((await $`git rev-parse HEAD`.text()).trim()).toBe(sha)
      expect((await $`git tag`.text()).trim()).toBe('')
      expect(((await Bun.file('package.json').json()) as { version: string }).version).toBe('1.0.0')
    })
  })

  test('--tagged keeps the user\'s own version commit and tag when the push is refused', async () => {
    await refusingTags(async (sha) => {
      await $`git commit -q --allow-empty -m v1.0.1 && git tag -a v1.0.1 -m v1.0.1`.quiet()

      const own = (await $`git rev-parse HEAD`.text()).trim()

      await withFakeTea({ issues: [], runs: passing(sha) }, async () => {
        // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
        await expect(capture(async () => release(['--tagged']))).rejects.toThrow('origin refused the push')
      })

      expect((await $`git rev-parse HEAD`.text()).trim()).toBe(own)
      expect((await $`git tag`.text()).trim()).toBe('v1.0.1')
    })
  })
})
