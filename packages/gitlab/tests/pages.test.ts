import { describe, expect, test } from 'bun:test'
import { logs } from '../src/commands/logs'
import { runs } from '../src/commands/runs'
import { jobsOf, pipelinesOn, recentPipelines } from '../src/pipelines'
import { job, pipeline, withFakeGlab } from './fake-glab'

const SHA = 'a'.repeat(40)
const many = (count: number) => Array.from({ length: count }, (_, index) => pipeline(index + 1, SHA, 'success'))
const rows = (out: string[]) => out.join('\n').split('\n').filter(line => (/^\d+\s/).test(line))

describe('listings past one page', () => {
  test('gl runs reads the pages it needs and counts what it leaves out', async () => {
    const { out, calls } = await withFakeGlab({ pipelines: many(250) }, async () => runs(['-n', '150']))

    expect(rows(out)).toHaveLength(150)
    expect(out.at(-1)).toBe('50+ more, rerun with --full')
    expect(calls).toEqual(['projects/:id/pipelines?per_page=100&page=1', 'projects/:id/pipelines?per_page=100&page=2'])
  })

  test('gl runs --full reads them all and prints no footer', async () => {
    const { out } = await withFakeGlab({ pipelines: many(230) }, async () => runs(['--full']))

    expect(rows(out)).toHaveLength(230)
    expect(out.join('\n')).not.toContain('more, rerun')
  })

  test('a listing that fits one page gives its exact rest', async () => {
    const { out } = await withFakeGlab({ pipelines: many(30) }, async () => runs(['-n', '10']))

    expect(out.at(-1)).toBe('20 more, rerun with --full')
  })

  test('the pipelines of a commit and the jobs of a pipeline are read whole', async () => {
    const jobs = Array.from({ length: 230 }, (_, index) => job(index + 1, `job${index + 1}`, 'success'))
    const state = { pipelines: many(120), jobs: { 5: jobs } }
    let found = { pipelines: 0, jobs: 0, recent: 0 }

    await withFakeGlab(state, async () => {
      found = { pipelines: (await pipelinesOn(SHA)).length, jobs: (await jobsOf(5)).length, recent: (await recentPipelines(Number.POSITIVE_INFINITY)).pipelines.length }
    })

    expect(found).toEqual({ pipelines: 120, jobs: 230, recent: 120 })
  })

  test('gl logs finds a failed job past the first page', async () => {
    const jobs = Array.from({ length: 150 }, (_, index) => job(index + 1, `job${index + 1}`, index === 129 ? 'failed' : 'success'))
    const { out } = await withFakeGlab({ pipelines: [pipeline(5, 'abc1234def', 'failed')], jobs: { 5: jobs }, traces: { 130: 'boom' } }, async () => logs(['5']))

    expect(out.join('\n')).toEndWith('job job130 (test): failed\nboom')
  })
})
