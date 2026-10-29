import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { commitPackageBump, taggedVersion } from '../src/commands/release'

describe('taggedVersion', () => {
  test('reads the version of a root or a package tag', () => {
    expect(taggedVersion('v1.2.0', 'v')).toBe('1.2.0')
    expect(taggedVersion('ft-v0.3.0-beta.1', 'ft-v')).toBe('0.3.0-beta.1')
  })

  test('passes over another package\'s tag and tags that are no version', () => {
    expect(taggedVersion('env-v0.1.0', 'ft-v')).toBeUndefined()
    expect(taggedVersion('ft-v0.3.0', 'v')).toBeUndefined()
    expect(taggedVersion('vnext', 'v')).toBeUndefined()
  })
})

describe('commitPackageBump', () => {
  test('commits a package bump with the lockfile, tagged with its folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ft-release-'))
    const dir = join(root, 'packages', 'a')
    const home = process.cwd()

    try {
      await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }))
      await Bun.write(join(dir, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
      await $`bun install && git init -q -b main && git add package.json packages bun.lock && git -c user.name=t -c user.email=t@t commit -q -m init`.cwd(root).quiet()
      await $`bun pm version patch --no-git-tag-version`.cwd(dir).quiet()
      process.chdir(root)
      await $`git config user.name t && git config user.email t@t`.quiet()
      await commitPackageBump(dir, 'a-v')

      expect((await $`git tag --points-at HEAD`.text()).trim()).toBe('a-v1.0.1')
      expect((await $`git log -1 --format=%s`.text()).trim()).toBe('a-v1.0.1')
      expect((await $`git status --porcelain`.text()).trim()).toBe('')
      expect(await Bun.file(join(root, 'bun.lock')).text()).toContain('"version": "1.0.1"')
    }
    finally {
      process.chdir(home)
      await rm(root, { recursive: true, force: true })
    }
  })
})
