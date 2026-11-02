import { describe, expect, test } from 'bun:test'
import { timing, watchRuns } from '../src/commands/watch'
import { jobLog } from '../src/runs'
import { refusal, withFakeTea } from './fake-tea'

const run = (id: number, status: string) => ({ id, commit_sha: 'abc', event: 'push', status, workflow_id: 'test.yml', prettyref: 'main', html_url: `https://forge/runs/${id}`, title: 'x' })

async function withFastPoll(runs: Record<string, unknown>[], body: () => Promise<void>): Promise<void> {
  const poll = timing.poll

  timing.poll = 1

  try {
    await withFakeTea({ issues: [], runs }, body)
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

describe('a job log', () => {
  test('throws Forgejo\'s error object instead of printing it as the log', async () => {
    await withFakeTea({ issues: [] }, async () => {
      expect(await refusal(jobLog(9))).toContain('not found')
    })
  })
})
