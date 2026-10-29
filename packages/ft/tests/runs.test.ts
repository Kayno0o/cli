import type { Run } from '../src/runs'
import { describe, expect, test } from 'bun:test'
import { judge } from '../src/commands/ci'
import { formatAge, formatSeconds } from '../src/format'
import { newestPerWorkflow, overall } from '../src/runs'

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

describe('overall', () => {
  test('is the worst status: failure, then unfinished, then success over skipped', () => {
    expect(overall([run(1, 'success'), run(2, 'failure'), run(3, 'running')])).toBe('failure')
    expect(overall([run(1, 'success'), run(2, 'waiting')])).toBe('waiting')
    expect(overall([run(1, 'success'), run(2, 'skipped')])).toBe('success')
    expect(overall([run(1, 'skipped')])).toBe('skipped')
  })
})

describe('format', () => {
  test('gives the largest unit and the next one when not zero', () => {
    expect(formatSeconds(0)).toBe('0s')
    expect(formatSeconds(57)).toBe('57s')
    expect(formatSeconds(808)).toBe('13m 28s')
    expect(formatSeconds(3605)).toBe('1h')
    expect(formatSeconds(90_000)).toBe('1d 1h')
    expect(formatAge(Date.now() - 3 * 3600_000 - 60_000)).toBe('3h ago')
    expect(formatAge('not a date')).toBe('-')
  })
})
