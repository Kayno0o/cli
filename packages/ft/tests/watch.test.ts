import type { FakeState } from './fake-tea'
import { describe, expect, test } from 'bun:test'
import { timing, watchRuns } from '../src/commands/watch'
import { jobLog, runsOn } from '../src/runs'
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

    await withFastPoll([run(2, 'success'), run(1, 'success')], async () => {
      expect(await watchRuns(runs => runs, 1000, undefined, undefined, out)).toBe(0)
    })

    const text = written.join('')
    const left = Bun.stripANSI(text.slice(text.lastIndexOf('\x1B[2K') + 4))

    expect(text).toContain('\x1B[1A')
    expect(left).toBe('test.yml run 2 on main: ✓ success\ntest.yml run 1 on main: ✓ success\n')
  })

  test('elsewhere, prints a line per run as it is first seen', async () => {
    const { written, out } = stream(false)

    await withFastPoll([run(2, 'success'), run(1, 'success')], async () => {
      expect(await watchRuns(runs => runs, 1000, undefined, undefined, out)).toBe(0)
    })

    expect(written.join('')).toBe('test.yml run 2 on main: success\ntest.yml run 1 on main: success\n')
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
