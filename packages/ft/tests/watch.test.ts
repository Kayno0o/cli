import type { Run } from '../src/runs'
import type { FakeState } from './fake-tea'
import { capture } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { timing, watch, watchRuns } from '../src/commands/watch'
import { failureText, jobLog, runLine, runsOn, stallReason } from '../src/runs'
import { refusal, withFakeTea } from './fake-tea'

const run = (id: number, status: string) => ({ id, commit_sha: 'abc', event: 'push', status, workflow_id: 'test.yml', prettyref: 'main', html_url: `https://forge/runs/${id}`, title: 'x' })

async function withFastPoll(runs: Record<string, unknown>[], body: () => Promise<void>, extra: Partial<FakeState> = {}): Promise<FakeState> {
  const poll = timing.poll

  timing.poll = 1

  try {
    return await withFakeTea({ issues: [], runs, ...extra }, body)
  }
  finally {
    timing.poll = poll
  }
}

describe('watchRuns', () => {
  test('says on the given stream, not stdout, that no run started', async () => {
    await withFastPoll([], async () => {
      const { result, out, err } = await capture(async () => watchRuns(runs => runs, 1000, undefined, 5, process.stderr))

      expect(result).toBe(0)
      expect(out).toBe('')
      expect(err).toBe('no run started, so nothing was waited for\n')
    })
  })

  test('keeps waiting for the other runs after one failed, as ft ci does', async () => {
    await withFastPoll([run(2, 'failure'), run(1, 'running')], async () => {
      expect(await refusal(watchRuns(runs => runs, 100))).toContain('did not finish')
    })
  })

  test('exits 1 once every run is over and one failed', async () => {
    await withFastPoll([run(2, 'failure'), run(1, 'success')], async () => {
      expect(await watchRuns(runs => runs, 1000)).toBe(1)
    })
  })

  test('exits 0 once every run passed or was skipped', async () => {
    await withFastPoll([run(2, 'skipped'), run(1, 'success')], async () => {
      expect(await watchRuns(runs => runs, 1000)).toBe(0)
    })
  })
})

describe('watchRuns output', () => {
  const stream = (isTTY: boolean) => {
    const written: string[] = []

    return { written, out: { isTTY, columns: 120, rows: 40, write: (text: string) => written.push(text) } }
  }

  test('on a terminal, redraws one line per run and leaves each run\'s last status once', async () => {
    const { written, out } = stream(true)
    // A terminal only takes control codes when nothing turns them off, as `check` does for its steps.
    const saved = { NO_COLOR: process.env.NO_COLOR, NODE_DISABLE_COLORS: process.env.NODE_DISABLE_COLORS, TERM: process.env.TERM }

    try {
      delete process.env.NO_COLOR
      delete process.env.NODE_DISABLE_COLORS
      process.env.TERM = 'xterm-256color'

      await withFastPoll([run(2, 'success'), run(1, 'success')], async () => {
        expect(await watchRuns(runs => runs, 1000, undefined, undefined, out)).toBe(0)
      })
    }
    finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined)
          delete process.env[name]
        else
          process.env[name] = value
      }
    }

    const text = written.join('')
    const left = Bun.stripANSI(text.slice(text.lastIndexOf('\x1B[J') + 3))

    expect(text).toContain('\x1B[2A')
    expect(left).toBe('✓ success test.yml run 2 on main\n✓ success test.yml run 1 on main\n')
  })

  test('elsewhere, prints a line per run as it is first seen', async () => {
    const { written, out } = stream(false)

    await withFastPoll([run(2, 'success'), run(1, 'success')], async () => {
      expect(await watchRuns(runs => runs, 1000, undefined, undefined, out)).toBe(0)
    })

    expect(written.join('')).toBe('success test.yml run 2 on main\nsuccess test.yml run 1 on main\n')
  })

  test('says how long a run has been running, and how long it took once over', async () => {
    const { written, out } = stream(false)
    const started = new Date(Date.now() - 75_000).toISOString()

    await withFastPoll([{ ...run(2, 'running'), started }, { ...run(1, 'success'), duration: 182e9 }], async () => {
      expect(await refusal(watchRuns(runs => runs, 100, undefined, undefined, out))).toContain('did not finish')
    })

    expect(written.join('')).toBe('running test.yml run 2 on main for 1m 15s\nsuccess test.yml run 1 on main in 3m 2s\n')
  })
})

describe('watchRuns failures', () => {
  test('polls again after tea answers an API error, including from the stall and failure lookups', async () => {
    const failures = [{ match: 'actions/runs?', message: 'internal error', times: 2 }, { match: '/jobs', message: 'internal error', times: 1 }]

    const state = await withFastPoll([run(2, 'failure')], async () => {
      expect(await watchRuns(runs => runs, 5000)).toBe(1)
    }, { failures })

    expect(state.failures?.map(each => each.times)).toEqual([0, 0])
  })

  test('fails at once when Forgejo answers that the target is gone', async () => {
    const started = Date.now()

    await withFastPoll([run(1, 'running')], async () => {
      expect(await refusal(watchRuns(runs => runs, 60_000))).toContain('couldn\'t be found')
    }, { failures: [{ match: 'actions/runs?', message: 'The target couldn\'t be found.' }] })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('fails at once when tea is not installed', async () => {
    const path = process.env.PATH
    const poll = timing.poll
    const started = Date.now()

    process.env.PATH = '/nonexistent'
    timing.poll = 1

    try {
      expect(await refusal(watchRuns(runs => runs, 60_000))).toContain('tea api')
      expect(Date.now() - started).toBeLessThan(5000)
    }
    finally {
      process.env.PATH = path
      timing.poll = poll
    }
  })
})

describe('runsOn', () => {
  test('reads every page of a commit\'s runs', async () => {
    const many = Array.from({ length: 120 }, (_, at) => ({ ...run(at + 1, 'success'), commit_sha: at < 110 ? 'abc' : 'other' }))

    await withFakeTea({ issues: [], runs: many }, async () => {
      expect(await runsOn('abc')).toHaveLength(110)
    })
  })
})

describe('a job log', () => {
  test('throws Forgejo\'s error object instead of printing it as the log', async () => {
    await withFakeTea({ issues: [] }, async () => {
      expect(await refusal(jobLog(9))).toContain('not found')
    })
  })
})

describe('ft watch --json and --quiet', () => {
  const failing = { jobs: { 2: [{ id: 20, name: 'test', status: 'failure', runs_on: null }] }, logs: { 20: 'it broke' } }

  test('prints status, runs, failed jobs with their excerpt and url on stdout, the failure text left out', async () => {
    let code = -1
    const { out, err } = await capture(async () => withFastPoll([run(2, 'failure'), run(1, 'success')], async () => {
      code = await watch(['--after', '0', '--json'])
    }, failing))

    expect(code).toBe(1)
    expect(JSON.parse(out)).toEqual({
      status: 'failure',
      runs: [{ id: 2, workflow: 'test.yml', status: 'failure', ref: 'main', sha: 'abc', url: 'https://forge/runs/2' }, { id: 1, workflow: 'test.yml', status: 'success', ref: 'main', sha: 'abc', url: 'https://forge/runs/1' }],
      failedJobs: [{ name: 'test', run: 2, workflow: 'test.yml', excerpt: 'it broke' }],
      url: 'https://forge/runs/2',
    })
    expect(err).not.toContain('it broke')
  })

  test('says none when nothing is in progress', async () => {
    const { out } = await capture(async () => withFastPoll([run(1, 'success')], async () => {
      await watch(['--json'])
    }))

    expect(JSON.parse(out)).toEqual({ status: 'none', runs: [], failedJobs: [], url: null })
  })

  test('--quiet prints the failure and each run\'s final status, no progress line', async () => {
    const { out, err } = await capture(async () => withFastPoll([run(2, 'failure')], async () => {
      await watch(['--after', '0', '--quiet'])
    }, failing))

    expect(err).toContain('job test of test.yml failed:\nit broke')
    expect(out).toBe('failure test.yml run 2 on main\n')
  })
})

describe('runLine', () => {
  test('links the run id to the run on a terminal, and leaves it plain elsewhere', () => {
    const queued = { ...run(5, 'waiting'), index_in_repo: 5, started: '', stopped: '', duration: 0 }

    expect(runLine(queued, {})).toBe('waiting test.yml run 5 on main')
    expect(runLine(queued, { isTTY: true })).toContain('\x1B]8;;https://forge/runs/5\x1B\\5\x1B]8;;\x1B\\')
  })
})

describe('failureText', () => {
  const jobs = [{ run: 5, name: 'test', workflow: 'test.yml', excerpt: 'it broke' }]

  test('colours only the title on a terminal, so the log under it is not red', () => {
    expect(failureText(jobs, {})).toBe('job test of test.yml failed:\nit broke')
    const drawn = failureText(jobs, { isTTY: true })

    expect(Bun.stripANSI(drawn)).toBe('job test of test.yml failed:\nit broke')
    expect(drawn.endsWith('failed\x1B[39m:\nit broke')).toBe(true)
  })
})

describe('stallReason', () => {
  const queued: Run[] = [{ ...run(1, 'waiting'), workflow_id: 'deploy.yml', index_in_repo: 1, started: '', stopped: '', duration: 0 }]
  const jobs = { 1: [{ id: 1, name: 'deploy', status: 'waiting', runs_on: ['deploy'] }] }
  const instance = [{ name: 'docker-runner', status: 'active', labels: ['alpine'] }]

  test('counts the repo\'s own runners, which the admin list leaves out', async () => {
    await withFakeTea({ issues: [], jobs, runners: instance, repoRunners: [{ name: 'deploy', status: 'active', labels: ['deploy'] }] }, async () => {
      expect(await stallReason(queued)).toBeUndefined()
    })
  })

  test('is certain when neither list holds a runner for the job', async () => {
    await withFakeTea({ issues: [], jobs, runners: instance, repoRunners: [] }, async () => {
      expect(await stallReason(queued)).toMatchObject({ certain: true })
    })
  })

  test('is not certain when the repo\'s runners cannot be read', async () => {
    await withFakeTea({ issues: [], jobs, runners: instance }, async () => {
      expect(await stallReason(queued)).toMatchObject({ certain: false })
    })
  })
})
