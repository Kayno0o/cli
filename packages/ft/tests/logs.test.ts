import { capture } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { logs, pickJobs } from '../src/commands/logs'
import { withFakeTea } from './fake-tea'

const jobs = [
  { id: 70, name: 'lint', status: 'success', runs_on: null },
  { id: 71, name: 'test', status: 'failure', runs_on: null },
]

describe('ft logs -j', () => {
  test('picks a job by name or by id', () => {
    expect(pickJobs(jobs, 'lint').map(job => job.id)).toEqual([70])
    expect(pickJobs(jobs, '71').map(job => job.name)).toEqual(['test'])
    expect(pickJobs(jobs, 'nope')).toEqual([])
  })

  test('takes the failed jobs, else every job, without one asked for', () => {
    expect(pickJobs(jobs, undefined).map(job => job.name)).toEqual(['test'])
    expect(pickJobs(jobs.slice(0, 1), undefined).map(job => job.name)).toEqual(['lint'])
  })
})

describe('ft logs --json', () => {
  test('prints the run, the picked jobs with their excerpt and the failed ones as failedJobs', async () => {
    const state = {
      issues: [],
      runs: [{ id: 5, commit_sha: 'abcdef0123', event: 'push', status: 'failure', workflow_id: 'test.yml', prettyref: 'main', html_url: 'https://forge/runs/5', title: 'x' }],
      jobs: { 5: [{ id: 50, name: 'lint', status: 'success', runs_on: null }, { id: 51, name: 'test', status: 'failure', runs_on: null }] },
      logs: { 50: 'fine', 51: 'broke' },
    }

    const { out } = await capture(async () => withFakeTea(state, async () => logs(['5', '--json'])))

    expect(JSON.parse(out)).toEqual({
      status: 'failure',
      runs: [{ id: 5, workflow: 'test.yml', status: 'failure', ref: 'main', sha: 'abcdef0123', url: 'https://forge/runs/5' }],
      failedJobs: [{ name: 'test', run: 5, workflow: 'test.yml', excerpt: 'broke' }],
      url: 'https://forge/runs/5',
      jobs: [{ name: 'test', id: 51, status: 'failure', excerpt: 'broke' }],
    })
  })
})
