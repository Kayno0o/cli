import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Exit, fail } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ci, judge, waitingOn } from '../src/commands/ci'
import { logs } from '../src/commands/logs'
import { retry } from '../src/commands/retry'
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
    expect(calls).toEqual(['projects/group%2Fsub%2Fapp/pipelines?per_page=100&page=1'])
  })
})

describe('gl runs --json', () => {
  const many = Array.from({ length: 12 }, (_, index) => pipeline(index + 1, 'f'.repeat(40), 'success'))

  test('is never cut on its own, only by --limit', async () => {
    process.chdir(clone)

    const all = await withFakeGlab({ pipelines: many }, async () => runs(['--json']))
    const some = await withFakeGlab({ pipelines: many }, async () => runs(['--json', '--limit', '3']))

    expect((JSON.parse(all.out.join('\n')) as unknown[]).length).toBe(12)
    expect((JSON.parse(some.out.join('\n')) as unknown[]).length).toBe(3)
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

  test('fails at once when GitLab answers 404 instead of polling to the timeout', async () => {
    process.chdir(clone)

    const started = Date.now()
    let refused = { code: 0, message: '' }

    await withFakeGlab({ pipelines: [], failures: [{ match: 'pipelines?sha=', message: '404 Not found (HTTP 404)' }] }, async () => {
      refused = await refusal(async () => ci(['--timeout', '10']))
    })

    expect(refused.message).toContain('404 Not found')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('refuses a commit that is not on the branch', async () => {
    process.chdir(clone)
    await $`git -c user.name=t -c user.email=t@t commit -q --allow-empty -m local`.cwd(clone).quiet()

    let refused = { code: 0, message: '' }

    await withFakeGlab({ pipelines: [] }, async () => {
      refused = await refusal(async () => ci(['HEAD']))
    })

    expect(refused.code).toBe(2)
    expect(refused.message).toStartWith('not on branch: ')
    expect(refused.message).toEndWith('is not on origin/main, push it first')
  })

  test('says timeout first when the wait runs out, leaving other exits as they are', async () => {
    const timedOut = await refusal(async () => waitingOn(async () => fail('CI has not finished on abc1234 in 30m')))
    const other = await refusal(async () => waitingOn(async () => fail('no runner: stuck')))

    expect(timedOut).toEqual({ code: 2, message: 'timeout: CI has not finished on abc1234 in 30m' })
    expect(other).toEqual({ code: 2, message: 'no runner: stuck' })
  })

  test('takes a commit as [ref] or --sha, not both', async () => {
    let refused = { code: 0, message: '' }

    await withFakeGlab({ pipelines: [] }, async () => {
      refused = await refusal(async () => ci(['--sha', 'HEAD', 'HEAD']))
    })

    expect(refused).toEqual({ code: 2, message: 'give the commit as [ref] or --sha, not both' })
  })

  test('--job: a pipeline that skipped that job leaves the work to the next commit\'s', async () => {
    process.chdir(clone)

    let code = -1
    const { out } = await withFakeGlab({
      pipelines: [pipeline(8, shas[0] ?? '', 'success'), pipeline(9, shas[1] ?? '', 'success')],
      jobs: { 8: [job(80, 'deploy', 'skipped')], 9: [job(90, 'deploy', 'success')] },
    }, async () => {
      code = await ci([shas[0] ?? '', '--job', 'deploy'])
    })

    expect(code).toBe(0)
    expect(out[0]).toBe(`following pipeline 9 on ${shas[1]?.slice(0, 7)}, which covers ${shas[0]?.slice(0, 7)}: https://gitlab/p/9`)
  })
})

describe('gl ci on a tag', () => {
  const tagged = async (tag: string, sha: string) => $`git tag ${tag} ${sha}`.cwd(clone).quiet()
  const untag = async (tag: string) => $`git tag -d ${tag}`.cwd(clone).quiet()

  test('follows the pipeline of a tag given by name, and exits on its result', async () => {
    process.chdir(clone)
    await tagged('v1.0.0', shas[1] ?? '')

    try {
      let code = -1
      const { out } = await withFakeGlab({ pipelines: [pipeline(8, shas[1] ?? '', 'success', 'v1.0.0')] }, async () => {
        code = await ci(['v1.0.0'])
      })

      expect(code).toBe(0)
      expect(out[0]).toBe(`following pipeline 8 on ${shas[1]?.slice(0, 7)}: https://gitlab/p/8`)

      const failing = await withFakeGlab({ pipelines: [pipeline(9, shas[1] ?? '', 'failed', 'v1.0.0')], jobs: { 9: [job(90, 'publish', 'failed')] }, traces: { 90: 'nope' } }, async () => {
        code = await ci(['v1.0.0'])
      })

      expect(code).toBe(1)
      expect(failing.err.join('\n')).toContain('job publish (test) failed')
    }
    finally {
      await untag('v1.0.0')
    }
  })

  test('a sha with only a tag pipeline follows it', async () => {
    process.chdir(clone)
    await tagged('v1.0.1', shas[1] ?? '')

    try {
      let code = -1

      await withFakeGlab({ pipelines: [pipeline(8, shas[1] ?? '', 'success', 'v1.0.1')] }, async () => {
        code = await ci(['--sha', shas[1] ?? ''])
      })

      expect(code).toBe(0)
    }
    finally {
      await untag('v1.0.1')
    }
  })

  test('the branch pipeline wins when both exist', async () => {
    process.chdir(clone)
    await tagged('v1.0.2', shas[1] ?? '')

    try {
      const { out } = await withFakeGlab({ pipelines: [pipeline(8, shas[1] ?? '', 'success', 'main'), pipeline(9, shas[1] ?? '', 'success', 'v1.0.2')] }, async () => ci([shas[1] ?? '']))

      expect(out[0]).toContain('following pipeline 8 ')
    }
    finally {
      await untag('v1.0.2')
    }
  })
})

describe('gl retry', () => {
  const state = { pipelines: [pipeline(7, 'abc', 'failed')], jobs: { 7: [job(70, 'phpunit', 'failed'), job(71, 'build', 'success')] } }

  test('retries the failed jobs of a pipeline', async () => {
    const { out, calls } = await withFakeGlab(state, async () => retry(['7']))

    expect(calls).toEqual(['POST projects/:id/pipelines/7/retry'])
    expect(out).toEqual(['retrying the failed jobs of pipeline 7: https://gitlab/p/7'])
  })

  test('retries one job by name in a pipeline, or by id alone, --json naming it', async () => {
    const byName = await withFakeGlab(state, async () => retry(['7', '-j', 'phpunit']))
    const byId = await withFakeGlab(state, async () => retry(['-j', '70', '--json']))

    expect(byName.calls).toEqual(['projects/:id/pipelines/7/jobs?per_page=100&page=1', 'POST projects/:id/jobs/70/retry'])
    expect(byName.out).toEqual(['retrying job phpunit (70): https://gitlab/j/70'])
    expect(JSON.parse(byId.out.join('\n'))).toEqual({ id: 70, name: 'phpunit', stage: 'test', status: 'running', url: 'https://gitlab/j/70' })
  })

  test('refuses a missing target, a job name without a pipeline and an unknown job', async () => {
    const attempts: string[][] = [[], ['-j', 'phpunit'], ['7', '-j', 'nope']]
    const refused: string[] = []

    for (const attempt of attempts) {
      await withFakeGlab(state, async () => {
        const { code, message } = await refusal(async () => retry(attempt))

        refused.push(`${code} ${message}`)
      })
    }

    expect(refused).toEqual([
      '2 a pipeline id or a job is needed',
      '2 without a pipeline, -j takes a job id, not phpunit',
      '2 pipeline 7 has no job nope: phpunit, build',
    ])
  })
})

interface Printed { failedJobs: { name: string, excerpt: string }[], jobs: unknown[] }

describe('gl ci --json and gl logs --json', () => {
  const printedBy = (lines: string[]) => JSON.parse(lines.join('\n')) as Printed
  const failing = {
    pipelines: [pipeline(9, '', 'failed')],
    jobs: { 9: [job(90, 'phpunit', 'failed'), job(91, 'lint', 'failed', { allow_failure: true })] },
    traces: { 90: FAILED_TRACE, 91: 'lint said no' },
  }

  test('ci prints the failed jobs on stdout, announcing on stderr', async () => {
    process.chdir(clone)

    let code = -1
    const state = { ...failing, pipelines: [pipeline(9, shas[1] ?? '', 'failed')] }
    const { out, err } = await withFakeGlab(state, async () => {
      code = await ci(['--json'])
    })
    const printed = printedBy(out)

    expect(code).toBe(1)
    expect(printed).toMatchObject({ status: 'failure', url: 'https://gitlab/p/9', runs: [{ id: 9, status: 'failure', sha: shas[1] }] })
    expect(printed.failedJobs.map(each => each.name)).toEqual(['phpunit'])
    expect(printed.failedJobs[0]?.excerpt).toContain('There was 1 failure:')
    expect(err).toEqual([`following pipeline 9 on ${shas[1]?.slice(0, 7)}: https://gitlab/p/9`])
  })

  test('ci passes with no failed job', async () => {
    process.chdir(clone)

    let code = -1
    const { out } = await withFakeGlab({ pipelines: [pipeline(8, shas[1] ?? '', 'success')] }, async () => {
      code = await ci(['--json'])
    })

    expect(code).toBe(0)
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'success', failedJobs: [] })
  })

  test('logs prints the picked jobs, a failed one that may fail left out of failedJobs', async () => {
    const both = await withFakeGlab(failing, async () => logs(['9', '--json', '-j', 'lint']))
    const printed = printedBy(both.out)

    expect(printed.jobs).toMatchObject([{ name: 'lint', status: 'failure', allowFailure: true, excerpt: 'lint said no' }])
    expect(printed.failedJobs).toEqual([])
    expect(printedBy((await withFakeGlab(failing, async () => logs(['9', '--json']))).out).failedJobs.map(each => each.name)).toEqual(['phpunit'])
  })
})
