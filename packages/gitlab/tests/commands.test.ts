import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Exit } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ci, judge } from '../src/commands/ci'
import { logs } from '../src/commands/logs'
import { runs } from '../src/commands/runs'
import { newest, waitingOnRunner } from '../src/pipelines'
import { job, pipeline, withFakeGlab } from './fake-glab'

const FAILED_TRACE = '2026-10-29T15:36:24Z 01O There was 1 failure:\n2026-10-29T15:36:24Z 01O 1) T::t\n2026-10-29T15:36:24Z 01O Failed.\n2026-10-29T15:36:25Z 00O ERROR: Job failed: exit code 2'

// A clone of a bare origin holding two pushed commits on main, the shas oldest first.
let root = ''
let clone = ''
let shas: string[] = []
const home = process.cwd()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'gl-repo-'))
  clone = join(root, 'clone')
  await $`git init -q --bare -b main ${join(root, 'origin.git')} && git clone -q ${join(root, 'origin.git')} ${clone}`.quiet()
  await $`git -c user.name=t -c user.email=t@t commit -q --allow-empty -m one && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m two && git push -q origin main && git remote set-head origin -a`.cwd(clone).quiet()
  shas = (await $`git rev-list --reverse main`.cwd(clone).text()).trim().split('\n')
})

afterAll(async () => {
  process.chdir(home)
  await rm(root, { recursive: true, force: true })
})

// The exit code and message a command ended on through fail.
async function refusal(run: () => Promise<number>): Promise<{ code: number, message: string }> {
  try {
    return { code: await run(), message: '' }
  }
  catch (error) {
    if (error instanceof Exit)
      return { code: error.code, message: error.message }

    throw error
  }
}

describe('pipelines', () => {
  test('a commit is judged by its newest pipeline, passed over when it was cancelled or skipped', () => {
    expect(newest([pipeline(1, 'a', 'failed'), pipeline(3, 'a', 'running'), pipeline(2, 'a', 'success')])?.id).toBe(3)
    expect(judge(undefined)).toEqual({ kind: 'none' })
    expect(judge(pipeline(1, 'a', 'canceled'))).toEqual({ kind: 'passed-over' })
    expect(judge(pipeline(1, 'a', 'skipped'))).toEqual({ kind: 'passed-over' })
    expect(judge(pipeline(1, 'a', 'running')).kind).toBe('pipeline')
  })

  test('jobs wait on a runner only while none of the pipeline runs', () => {
    expect(waitingOnRunner([job(1, 'a', 'pending'), job(2, 'b', 'running')])).toEqual([])
    expect(waitingOnRunner([job(1, 'a', 'pending'), job(2, 'b', 'created')]).map(each => each.name)).toEqual(['a'])
  })
})

describe('gl runs', () => {
  test('lists pipelines with the subject of each commit the clone has, through the project --repo names', async () => {
    process.chdir(clone)

    const { out, calls } = await withFakeGlab({ pipelines: [pipeline(5, shas[1] ?? '', 'success'), pipeline(6, 'f'.repeat(40), 'running')] }, async () => runs(['-r', 'group/sub/app']))
    const [header, ...rows] = out.join('\n').split('\n')

    expect(header).toMatch(/^ID\s+STATUS\s+REF\s+SOURCE\s+SHA\s+TOOK\s+CREATED\s+TITLE$/)
    expect(rows[0]).toMatch(/^6\s+running\s+main\s+push\s+fffffff\s+-\s+/)
    expect(rows[1]).toMatch(/^5\s+success\s+main\s+push\s+\w{7}\s+2m 5s\s+\S+ ago\s+two$/)
    expect(calls).toEqual(['projects/group%2Fsub%2Fapp/pipelines?per_page=10'])
  })
})

describe('gl logs', () => {
  const state = {
    pipelines: [pipeline(7, 'abc1234def', 'failed')],
    jobs: { 7: [job(70, 'lint', 'failed', { allow_failure: true }), job(71, 'phpunit', 'failed'), job(72, 'build', 'success')] },
    traces: { 70: 'lint said no', 71: FAILED_TRACE, 72: 'built' },
  }

  test('prints the failed jobs that may not fail, each failed test from the trace', async () => {
    const { out } = await withFakeGlab(state, async () => logs(['7']))

    expect(out.join('\n')).toBe('pipeline 7 on main (abc1234): failed, https://gitlab/p/7\n\njob phpunit (test): failed\nThere was 1 failure:\n\n1) T::t\nFailed.\n\nERROR: Job failed: exit code 2')
  })

  test('picks a job by name or id, whole with --full', async () => {
    const { out } = await withFakeGlab(state, async () => logs(['7', '-j', '70', '--full']))

    expect(out.join('\n')).toEndWith('job lint (test): failed, allowed to fail\nlint said no')
    expect((await withFakeGlab(state, async () => logs(['7', '-j', 'build']))).out.at(-1)).toEndWith('built')
  })

  test('refuses a job the pipeline lacks, naming those it has', async () => {
    let refused = { code: 0, message: '' }

    await withFakeGlab(state, async () => {
      refused = await refusal(async () => logs(['7', '-j', 'nope']))
    })

    expect(refused).toEqual({ code: 2, message: 'pipeline 7 has no job nope: lint, phpunit, build' })
  })
})

describe('gl ci', () => {
  test('passes on the commit\'s own pipeline', async () => {
    process.chdir(clone)

    let code = -1
    const { out } = await withFakeGlab({ pipelines: [pipeline(8, shas[1] ?? '', 'success')] }, async () => {
      code = await ci([])
    })

    expect(code).toBe(0)
    expect(out.at(-1)).toBe(`CI passed on ${shas[1]?.slice(0, 7)}`)
  })

  test('follows the next commit\'s pipeline when the commit\'s own was cancelled, and prints its failed jobs', async () => {
    process.chdir(clone)

    let code = -1
    const { out, err } = await withFakeGlab({
      pipelines: [pipeline(8, shas[0] ?? '', 'canceled'), pipeline(9, shas[1] ?? '', 'failed')],
      jobs: { 9: [job(90, 'phpunit', 'failed')] },
      traces: { 90: FAILED_TRACE },
    }, async () => {
      code = await ci([shas[0] ?? ''])
    })

    expect(code).toBe(1)
    expect(out[0]).toBe(`following pipeline 9 on ${shas[1]?.slice(0, 7)}, which covers ${shas[0]?.slice(0, 7)}: https://gitlab/p/9`)
    expect(err.join('\n')).toContain('job phpunit (test) failed: https://gitlab/j/90\nThere was 1 failure:')
    expect(err.join('\n')).toEndWith(`pipeline 9 failed, testing every commit from ${shas[0]?.slice(0, 7)} to ${shas[1]?.slice(0, 7)}: https://gitlab/p/9`)
  })

  test('refuses a commit that is not on the branch', async () => {
    process.chdir(clone)
    await $`git -c user.name=t -c user.email=t@t commit -q --allow-empty -m local`.cwd(clone).quiet()

    let refused = { code: 0, message: '' }

    await withFakeGlab({ pipelines: [] }, async () => {
      refused = await refusal(async () => ci(['HEAD']))
    })

    expect(refused.code).toBe(2)
    expect(refused.message).toEndWith('is not on origin/main: push it first')
  })
})
