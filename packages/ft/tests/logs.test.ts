import { describe, expect, test } from 'bun:test'
import { pickJobs } from '../src/commands/logs'

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
