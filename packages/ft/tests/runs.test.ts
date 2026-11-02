import type { Run } from '../src/runs'
import { describe, expect, test } from 'bun:test'
import { commitsToAsk, judge, settled } from '../src/commands/ci'
import { newestPerWorkflow, overall, startedAge } from '../src/runs'

function run(id: number, status: string, workflow = 'test.yml', event = 'push'): Run {
  return { id, status, workflow_id: workflow, event, index_in_repo: id, title: '', commit_sha: 'abc', html_url: '', prettyref: 'main', started: '', stopped: '', duration: 0 }
}

describe('newestPerWorkflow', () => {
  test('keeps the newest push run of each workflow, or of the one asked for', () => {
    const runs = [run(1, 'cancelled'), run(3, 'running'), run(2, 'success', 'lint.yml'), run(4, 'success', 'test.yml', 'pull_request')]

    expect(newestPerWorkflow(runs).map(found => found.id)).toEqual([2, 3])
    expect(newestPerWorkflow(runs, 'test.yml').map(found => found.id)).toEqual([3])
  })
})

describe('judge', () => {
  test('follows unfinished runs, and passes over a commit whose run was cancelled', () => {
    expect(judge([], false, false)).toEqual({ kind: 'none' })
    expect(judge([run(1, 'running'), run(2, 'cancelled')], false, false).kind).toBe('runs')
    expect(judge([run(1, 'success'), run(2, 'cancelled', 'lint.yml')], false, false)).toEqual({ kind: 'passed-over' })
  })

  test('passes over a run whose job was skipped, unless the commit is a tagged release', () => {
    expect(judge([run(1, 'success')], true, false)).toEqual({ kind: 'passed-over' })

    const release = judge([run(1, 'success')], true, true)

    expect(release.kind === 'runs' && release.runs.map(found => found.status)).toEqual(['skipped'])
  })
})

describe('settled', () => {
  test('keeps refreshed runs that are all over, but not one holding a cancelled run', () => {
    expect(settled([run(1, 'success'), run(2, 'failure')])?.length).toBe(2)
    expect(settled([run(1, 'success'), run(2, 'cancelled')])).toBeUndefined()
    expect(settled([run(1, 'running')])).toBeUndefined()
    expect(settled(undefined)).toBeUndefined()
  })
})

describe('commitsToAsk', () => {
  test('skips commits already passed over and caps a long gap', () => {
    const commits = Array.from({ length: 50 }, (_, at) => `c${at}`)

    expect(commitsToAsk(commits, new Set(['c0', 'c1']), 3)).toEqual(['c2', 'c3', 'c4'])
    expect(commitsToAsk(commits, new Set())).toHaveLength(20)
  })
})

describe('overall', () => {
  test('is the worst status: failure, then unfinished, then success over skipped', () => {
    expect(overall([run(1, 'success'), run(2, 'failure'), run(3, 'running')])).toBe('failure')
    expect(overall([run(1, 'success'), run(2, 'waiting')])).toBe('waiting')
    expect(overall([run(1, 'success'), run(2, 'skipped')])).toBe('success')
    expect(overall([run(1, 'skipped')])).toBe('skipped')
  })
})

describe('startedAge', () => {
  test('is - for a run that never started, whose start is the zero time', () => {
    const now = Date.parse('2026-10-23T12:00:00Z')

    expect(startedAge({ ...run(1, 'waiting'), started: '0001-01-01T00:00:00Z' }, now)).toBe('-')
    expect(startedAge({ ...run(1, 'running'), started: '2026-10-23T10:00:00Z' }, now)).toBe('2h ago')
  })
})
