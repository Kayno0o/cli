import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { commitPackageBump, nextVersion, release, taggedVersion, testsPass } from '../src/commands/release'
import { timing } from '../src/commands/watch'
import { withFakeTea } from './fake-tea'

const temp = tempDirs()

describe('release --json', () => {
  test('refuses --dry-run, which prints a plan and no result', async () => {
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(capture(async () => release(['patch', '--json', '--dry-run']))).rejects.toThrow('--json does not take --dry-run')
  })
})

describe('testsPass on a commit origin has', () => {
  const run = (sha: string, status: string) => ({ id: 7, commit_sha: sha, event: 'push', status, workflow_id: 'test.yml', prettyref: 'main', html_url: 'https://forge/runs/7', title: 'feat', duration: 60e9 })

  async function pushedRepo(): Promise<string> {
    const root = temp('ft-tests-pass-')

    await $`git init -q --bare -b main ${root}/origin.git && git clone -q ${root}/origin.git ${root}/work`.cwd(root).quiet()
    await $`git -C ${root}/work -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && git -C ${root}/work push -q origin main`.quiet()

    return join(root, 'work')
  }

  async function inRepo<T>(work: string, poll: number, body: () => Promise<T>): Promise<T> {
    const home = process.cwd()
    const saved = timing.poll

    process.chdir(work)
    timing.poll = poll

    try {
      return await body()
    }
    finally {
      timing.poll = saved
      process.chdir(home)
    }
  }

  test('neither waits for nor prints runs that already passed, as after the previous release', async () => {
    const work = await pushedRepo()
    const sha = (await $`git -C ${work} rev-parse HEAD`.text()).trim()

    await withFakeTea({ issues: [], runs: [run(sha, 'success')] }, async () => {
      // A poll this slow would time the test out, so passing proves the wait was skipped.
      const { result, out } = await inRepo(work, 60_000, async () => capture(async () => testsPass(sha, 'main', 1000)))

      expect(result).toBe(true)
      expect(out).toBe('')
    })
  })

  test('says what it waits for when they have not passed', async () => {
    const work = await pushedRepo()
    const sha = (await $`git -C ${work} rev-parse HEAD`.text()).trim()

    await withFakeTea({ issues: [], runs: [run(sha, 'failure')] }, async () => {
      const { result, out } = await inRepo(work, 1, async () => capture(async () => testsPass(sha, 'main', 1000)))

      expect(result).toBe(false)
      expect(out).toStartWith(`main at ${sha.slice(0, 7)} is on origin, waiting for its runs before the bump\nfailure test.yml run 7 on main in 1m\n`)
    })
  })
})

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

describe('nextVersion', () => {
  test('bumps as bun pm version does', () => {
    expect(['patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'prerelease', '3.0.0'].map(level => nextVersion('1.2.3', level))).toEqual(['1.2.4', '1.3.0', '2.0.0', '1.2.4-0', '1.3.0-0', '2.0.0-0', '1.2.4-0', '3.0.0'])
    expect(['patch', 'minor', 'prerelease'].map(level => nextVersion('1.3.0-beta.1', level))).toEqual(['1.3.0', '1.3.0', '1.3.0-beta.2'])
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
      await $`git config user.name t && git config user.email t@t`.cwd(root).quiet()
      await commitPackageBump(dir, 'a-v')

      expect((await $`git tag --points-at HEAD`.cwd(root).text()).trim()).toBe('a-v1.0.1')
      expect((await $`git log -1 --format=%s`.cwd(root).text()).trim()).toBe('a-v1.0.1')
      expect((await $`git status --porcelain`.cwd(root).text()).trim()).toBe('')
      expect(await Bun.file(join(root, 'bun.lock')).text()).toContain('"version": "1.0.1"')
    }
    finally {
      process.chdir(home)
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('release', () => {
  test('--dry-run prints the plan and pushes, commits and tags nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ft-release-'))
    const origin = join(root, 'origin.git')
    const work = join(root, 'work')
    const home = process.cwd()

    try {
      await $`git init -q --bare -b main ${origin} && git clone -q ${origin} ${work}`.cwd(root).quiet()
      process.chdir(work)
      await Bun.write(join(work, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
      await $`git config user.name t && git config user.email t@t && git add package.json && git commit -q -m init && git push -q origin main`.cwd(work).quiet()
      await Bun.write(join(work, 'a.ts'), 'export {}\n')
      await $`git add a.ts && git commit -q -m feat`.cwd(work).quiet()

      const sha = (await $`git rev-parse HEAD`.cwd(work).text()).trim()
      const pushed = (await $`git rev-parse origin/main`.cwd(work).text()).trim()
      const { result, out } = await capture(async () => release(['minor', '--dry-run']))

      expect(result).toBe(0)
      expect(out).toBe(`would release a 1.0.0 -> 1.1.0, tagged v1.1.0\n  1. push main at ${sha.slice(0, 7)}, which origin lacks, then wait for its runs\n  2. bun pm version minor, which commits and tags v1.1.0\n  3. push main and v1.1.0 in one atomic push, then wait for the runs it starts (15m at most)\n  4. wait for the registry to serve a@1.1.0\ndry run: nothing was pushed, committed or tagged\n`)
      expect((await $`git tag`.cwd(work).text()).trim()).toBe('')
      expect((await $`git ls-remote --tags origin`.cwd(work).text()).trim()).toBe('')
      expect((await $`git rev-parse origin/main HEAD`.cwd(work).text()).trim().split('\n')).toEqual([pushed, sha])
      expect((await $`git status --porcelain`.cwd(work).text()).trim()).toBe('')

      await $`git tag -a v1.0.1 -m v1.0.1`.cwd(work).quiet()
      expect((await capture(async () => release(['--tagged', '--dry-run', '--no-registry']))).out).toStartWith('would release a 1.0.1, tagged v1.0.1\n')
      await $`git tag -d v1.0.1`.cwd(work).quiet()
      // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
      await expect(capture(async () => release(['--tagged', '--dry-run']))).rejects.toThrow('HEAD carries no v* tag')

      await Bun.write(join(work, 'b.ts'), 'export {}\n')
      await $`git add b.ts`.cwd(work).quiet()
      // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
      await expect(capture(async () => release(['patch', '--dry-run']))).rejects.toThrow('the tree has uncommitted changes')
    }
    finally {
      process.chdir(home)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('plans the push of HEAD when origin has no branch yet, a stale tracking ref dropped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ft-release-'))
    const origin = join(root, 'origin.git')
    const work = join(root, 'work')
    const home = process.cwd()

    try {
      await $`git init -q --bare -b main ${origin} && git clone -q ${origin} ${work}`.cwd(root).quiet()
      process.chdir(work)
      await Bun.write(join(work, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
      await $`git config user.name t && git config user.email t@t && git add package.json && git commit -q -m init && git update-ref refs/remotes/origin/main HEAD`.cwd(work).quiet()

      const sha = (await $`git rev-parse HEAD`.cwd(work).text()).trim()
      const { result, out } = await capture(async () => release(['minor', '--dry-run', '--no-registry']))

      expect(result).toBe(0)
      expect(out).toContain(`1. push main at ${sha.slice(0, 7)}, which origin lacks, then wait for its runs\n`)
      expect((await $`git rev-parse --verify -q origin/main`.cwd(work).nothrow().quiet()).exitCode).toBe(1)
    }
    finally {
      process.chdir(home)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('stops before the bump when the runs on the commit fail, leaving no tag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ft-release-'))
    const origin = join(root, 'origin.git')
    const work = join(root, 'work')
    const home = process.cwd()
    const poll = timing.poll

    try {
      await $`git init -q --bare -b main ${origin} && git clone -q ${origin} ${work}`.cwd(root).quiet()
      process.chdir(work)
      await Bun.write(join(work, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
      await $`git config user.name t && git config user.email t@t && git add package.json && git commit -q -m init && git push -q origin main`.cwd(work).quiet()
      await Bun.write(join(work, 'a.ts'), 'export {}\n')
      await $`git add a.ts && git commit -q -m feat`.cwd(work).quiet()

      const sha = (await $`git rev-parse HEAD`.cwd(work).text()).trim()
      const runs = [{ id: 7, commit_sha: sha, event: 'push', status: 'failure', workflow_id: 'test.yml', prettyref: 'main', html_url: 'https://forge/runs/7', title: 'feat' }]

      timing.poll = 1
      await withFakeTea({ issues: [], runs }, async () => {
        // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
        await expect(capture(async () => release(['patch']))).rejects.toThrow('nothing was bumped or tagged')
      })

      expect((await $`git tag`.cwd(work).text()).trim()).toBe('')
      expect((await $`git ls-remote --tags origin`.cwd(work).text()).trim()).toBe('')
      expect((await $`git rev-parse origin/main`.cwd(work).text()).trim()).toBe(sha)
      expect(((await Bun.file(join(work, 'package.json')).json()) as { version: string }).version).toBe('1.0.0')
    }
    finally {
      timing.poll = poll
      process.chdir(home)
      await rm(root, { recursive: true, force: true })
    }
  })
})
