import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { capture } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { limits, release } from '../src/commands/release'
import { timing } from '../src/commands/watch'
import { withFakeTea } from './fake-tea'

// A clone whose origin refuses every tag (or runs `hookScript` on each pushed ref), with an unpushed `feat` commit.
async function refusingTags(run: (sha: string) => Promise<void>, hookScript = 'while read old new ref; do case "$ref" in refs/tags/*) echo "no tags here" >&2; exit 1;; esac; done'): Promise<void> {
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
    await Bun.write(hook, `#!/bin/sh\n${hookScript}\n`)
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

  test('a failed package bump commit restores package.json and bun.lock, so a retry is not blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ft-release-'))
    const work = join(root, 'work')
    const home = process.cwd()
    const poll = timing.poll

    try {
      await $`git init -q --bare -b main ${join(root, 'origin.git')} && git clone -q ${join(root, 'origin.git')} ${work}`.quiet()
      process.chdir(work)
      await Bun.write(join(work, 'package.json'), JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }))
      await Bun.write(join(work, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
      await $`bun install && git config user.name t && git config user.email t@t && git add package.json packages bun.lock && git commit -q -m init && git push -q origin main`.quiet()

      const sha = (await $`git rev-parse HEAD`.text()).trim()
      const lock = await Bun.file('bun.lock').text()

      await Bun.write(join(work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho nope >&2\nexit 1\n')
      await chmod(join(work, '.git', 'hooks', 'pre-commit'), 0o755)
      timing.poll = 1

      await withFakeTea({ issues: [], runs: passing(sha) }, async () => {
        // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
        await expect(capture(async () => release(['patch', '-p', 'a']))).rejects.toThrow()
      })

      expect((await $`git status --porcelain`.text()).trim()).toBe('')
      expect(await Bun.file('bun.lock').text()).toBe(lock)
      expect(((await Bun.file('packages/a/package.json').json()) as { version: string }).version).toBe('1.0.0')
    }
    finally {
      timing.poll = poll
      process.chdir(home)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the tag is pushed as a tag even when a branch has the same name', async () => {
    await refusingTags(async (sha) => {
      await $`git branch v1.0.1 && git push -q origin v1.0.1`.quiet()

      try {
        await withFakeTea({ issues: [], runs: passing(sha) }, async () => capture(async () => release(['patch', '-t', '1s'])))
      }
      catch {}

      expect((await $`git ls-remote --tags origin`.text())).toContain('refs/tags/v1.0.1')
    }, 'true')
  })

  test('a push that times out keeps the bump, as it may have landed', async () => {
    const pushMs = limits.pushMs

    limits.pushMs = 1000

    try {
      await refusingTags(async (sha) => {
        await withFakeTea({ issues: [], runs: passing(sha) }, async () => {
          // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
          await expect(capture(async () => release(['patch']))).rejects.toThrow('the push may have landed')
        })

        expect((await $`git tag`.text()).trim()).toBe('v1.0.1')
        expect(((await Bun.file('package.json').json()) as { version: string }).version).toBe('1.0.1')
      }, 'while read old new ref; do case "$ref" in refs/tags/*) sleep 5;; esac; done')
    }
    finally {
      limits.pushMs = pushMs
    }
  }, 20_000)
})
