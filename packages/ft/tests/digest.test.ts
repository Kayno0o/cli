import type { Session } from '@kaynooo/cli-kit'
import type { Run } from '../src/runs'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { capture } from '@kaynooo/cli-kit/test'
import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { claims, digest, dirtyFiles, renderDigest, unsettled } from '../src/commands/digest'
import { withFakeTea } from './fake-tea'

const session = (name: string, pid: number): Session => ({ name, pid, status: 'busy', cwd: '/w' })
const issue = (number: number, body = '- [ ] a\n- [x] b') => ({ number, title: `issue ${number}`, body, state: 'open', html_url: '', comments: 0, labels: [] })

function run(id: number, status: string, workflow = 'test.yml', ref = 'main'): Run {
  return { id, status, workflow_id: workflow, event: 'push', index_in_repo: id, title: 'a commit', commit_sha: 'abc', html_url: '', prettyref: ref, started: '2026-10-23T10:00:00Z', stopped: '', duration: 0 }
}

describe('claims', () => {
  test('holds the claims of the calling session and its lanes, and reports those no live session answers to', () => {
    const sessions = [session('kayjs-60', 1), session('kayjs-80', 2)]
    const claim = (holder: string) => ({ holder, at: '2026-10-23T10:00:00Z' })
    const result = claims([
      { issue: issue(1), claim: claim('kayjs-60') },
      { issue: issue(2), claim: claim('lane-60-2') },
      { issue: issue(3), claim: claim('kayjs-80') },
      { issue: issue(4), claim: claim('kayjs-12') },
      { issue: issue(5), claim: undefined },
    ], sessions, sessions[0])

    expect(result.held.map(row => [row.number, row.boxesLeft, row.boxesTotal])).toEqual([[1, 1, 2], [2, 1, 2]])
    expect(result.away.map(row => row.number)).toEqual([4])
  })

  test('holds nothing when it is not run from a session', () => {
    expect(claims([{ issue: issue(1), claim: { holder: 'kayjs-60', at: '2026-10-23T10:00:00Z' } }], [session('kayjs-60', 1)], undefined).held).toEqual([])
  })
})

describe('unsettled', () => {
  test('keeps the newest run of each workflow on the branch when it failed or is unfinished', () => {
    const runs = [run(1, 'failure'), run(2, 'success'), run(3, 'running', 'lint.yml'), run(4, 'failure', 'docs.yml', 'feature'), run(5, 'success', 'docs.yml')]

    expect(unsettled(runs, 'main').map(found => found.id)).toEqual([3])
    expect(unsettled([run(1, 'success'), run(2, 'failure')], 'main').map(found => found.id)).toEqual([2])
  })
})

describe('dirtyFiles', () => {
  test('reads the status and path of each line', () => {
    expect(dirtyFiles(' M src/a.ts\n?? new file.ts\nA  b.ts')).toEqual([{ status: 'M', path: 'src/a.ts' }, { status: '??', path: 'new file.ts' }, { status: 'A', path: 'b.ts' }])
  })
})

describe('renderDigest', () => {
  test('leaves empty sections out', () => {
    expect(renderDigest({ held: [], away: [], ci: [], unpushed: [], dirty: [], stale: [] })).toBe('nothing to pick up')
    expect(renderDigest({ held: [], away: [], ci: [], unpushed: ['abc1234 feat'], dirty: [], stale: [] })).toBe('unpushed commits (1)\n  abc1234 feat')
  })
})

describe('digest', () => {
  test('summarises claims, CI, git and stale TODOs from a stubbed tea, git and todo-scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ft-digest-'))
    const origin = join(root, 'origin.git')
    const work = join(root, 'work')
    const home = process.cwd()
    const savedPath = process.env.PATH

    try {
      await $`git init -q --bare -b main ${origin} && git clone -q ${origin} ${work}`.quiet()
      process.chdir(work)
      await Bun.write(join(work, 'a.ts'), 'export {}\n')
      await $`git config user.name t && git config user.email t@t && git add a.ts && git commit -q -m init && git push -q origin main`.quiet()
      await Bun.write(join(work, 'a.ts'), 'export const a = 1\n')
      await $`git commit -q -am second`.quiet()
      await Bun.write(join(work, 'scratch.ts'), '\n')

      const bin = join(root, 'bin')

      await Bun.write(join(bin, 'todo-scan'), `#!/bin/sh\necho '[{"path":"src/a.ts","line":3,"kind":"TODO","text":"TODO x","refs":[{"repo":"o/r","number":7,"state":"closed"}]},{"path":"src/b.ts","line":9,"kind":"ref","text":"o/r#7","refs":[{"repo":"o/r","number":7,"state":"closed"}]}]'\nexit 1\n`)
      await chmod(join(bin, 'todo-scan'), 0o755)

      const state = {
        issues: [{ number: 5, title: 'abandoned', body: '- [ ] one\n- [ ] two', state: 'open' }, { number: 6, title: 'free', body: '', state: 'open' }],
        comments: { 5: ['Taken by session gone-1.'] },
        runs: [{ ...run(10, 'failure'), duration: 0 }, { ...run(11, 'success', 'lint.yml') }],
      }

      await withFakeTea(state, async () => {
        process.env.PATH = `${bin}:${process.env.PATH ?? ''}`

        const { out } = await capture(async () => digest([]))

        expect(out).toContain('claimed, no live session here (1)')
        expect(out).toContain('#5')
        expect(out).toContain('2/2 left')
        expect(out).not.toContain('#6')
        expect(out).toContain('CI on the default branch (1)')
        expect(out).toContain('test.yml failure (run 10)')
        expect(out).toContain('unpushed commits (1)')
        expect(out).toContain('second')
        expect(out).toContain('dirty files (1)')
        expect(out).toContain('?? scratch.ts')
        expect(out).toContain('o/r#7 closed: src/a.ts:3, src/b.ts:9')

        const json = JSON.parse((await capture(async () => digest(['--json']))).out) as { away: { number: number }[], stale: { issue: string }[], held: unknown[] }

        expect(json.away.map(row => row.number)).toEqual([5])
        expect(json.held).toEqual([])
        expect(json.stale.map(each => each.issue)).toEqual(['o/r#7'])
      })
    }
    finally {
      process.chdir(home)
      process.env.PATH = savedPath
      await rm(root, { recursive: true, force: true })
    }
  })

  test('leaves the stale TODO section out when todo-scan is not on the PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ft-digest-'))
    const home = process.cwd()

    try {
      await $`git init -q -b main ${root}`.quiet()
      process.chdir(root)

      await withFakeTea({ issues: [], runs: [] }, async () => {
        const saved = process.env.PATH

        process.env.PATH = (saved ?? '').split(':').filter(dir => !Bun.file(join(dir, 'todo-scan')).size).join(':')

        try {
          expect((await capture(async () => digest([]))).out).toBe('nothing to pick up\n')
        }
        finally {
          process.env.PATH = saved
        }
      })
    }
    finally {
      process.chdir(home)
      await rm(root, { recursive: true, force: true })
    }
  })
})
