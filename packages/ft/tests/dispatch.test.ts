import type { FakeState } from './fake-tea'
import { capture } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { dispatch } from '../src/commands/dispatch'
import { timing } from '../src/commands/watch'
import { refusal, withFakeTea } from './fake-tea'

const REPO = ['-r', 'kaynooo/cli']

async function dispatched(state: Partial<FakeState>, args: string[]) {
  const poll = timing.poll
  let ran = { result: 0 as unknown, out: '', err: '' }

  timing.poll = 1

  try {
    const after = await withFakeTea({ issues: [], workflows: ['apps.yml'], ...state }, async () => {
      ran = await capture(async () => dispatch([...args, ...REPO]))
    })

    return { ...ran, state: after }
  }
  finally {
    timing.poll = poll
  }
}

describe('ft dispatch', () => {
  test('starts the workflow on the default branch with its inputs and prints the run', async () => {
    const { result, out, state } = await dispatched({ defaultBranch: 'trunk' }, ['apps.yml', '-i', 'target=prod', '-i', 'note=a=b'])

    expect(result).toBe(0)
    expect(out).toBe('started apps.yml run 1 on trunk: https://forge/runs/1\n')
    expect(state.runs?.[0]).toMatchObject({ id: 1, event: 'workflow_dispatch', prettyref: 'trunk', inputs: { target: 'prod', note: 'a=b' } })
  })

  test('runs the --ref given without asking for the default branch, and sends no inputs when none are given', async () => {
    const { result, state } = await dispatched({}, ['apps.yml', '--ref', 'v1.2.0'])
    const post = state.calls?.find(call => call.includes('POST'))

    expect(result).toBe(0)
    expect(state.calls?.some(call => call.at(-1) === 'repos/{owner}/{repo}')).toBe(false)
    expect(post).toContain('ref=v1.2.0')
    expect(post?.some(arg => arg.startsWith('inputs='))).toBe(false)
    expect(state.runs?.[0]).toMatchObject({ prettyref: 'v1.2.0' })
  })

  test('--json prints the run as JSON', async () => {
    const { out } = await dispatched({}, ['apps.yml', '--json'])

    expect(JSON.parse(out)).toEqual({ id: 1, number: 1, workflow: 'apps.yml', ref: 'main', url: 'https://forge/runs/1' })
  })

  test('--wait follows the run to its end and exits 1 when it fails', async () => {
    const passed = await dispatched({ dispatchStatus: 'success' }, ['apps.yml', '--wait', '-q'])
    const failed = await dispatched({ dispatchStatus: 'failure' }, ['apps.yml', '--wait', '-q'])

    expect(passed.result).toBe(0)
    expect(passed.out).toContain('started apps.yml run 1 on main')
    expect(passed.out).toContain('success')
    expect(failed.result).toBe(1)
  })

  test('--wait --json prints the watch result only on stdout', async () => {
    const { result, out, err } = await dispatched({ dispatchStatus: 'success' }, ['apps.yml', '--wait', '--json'])

    expect(result).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ status: 'success', runs: [{ id: 1 }] })
    expect(err).toContain('started apps.yml run 1')
  })

  test('--wait gives up after --timeout on a run that does not finish', async () => {
    let message = ''

    await withFakeTea({ issues: [], workflows: ['apps.yml'], dispatchStatus: 'running' }, async () => {
      const poll = timing.poll

      timing.poll = 1

      try {
        message = await refusal(capture(async () => dispatch(['apps.yml', '--wait', '-q', '-t', '1s', ...REPO])))
      }
      finally {
        timing.poll = poll
      }
    })

    expect(message).toContain('did not finish in')
  })

  test('a Forgejo that does not say which run started is told on stderr, and refused under --wait or --json', async () => {
    const plain = await dispatched({ noRunInfo: true }, ['apps.yml'])

    expect(plain.result).toBe(0)
    expect(plain.out).toBe('')
    expect(plain.err).toContain('apps.yml started on main, but Forgejo did not say which run: ft runs -w apps.yml lists it')

    for (const flag of ['--wait', '--json']) {
      await withFakeTea({ issues: [], workflows: ['apps.yml'], noRunInfo: true }, async () => {
        expect(await refusal(dispatch(['apps.yml', flag, ...REPO]))).toContain(`so it cannot be ${flag === '--wait' ? 'followed' : 'printed'}`)
      })
    }
  })

  test('surfaces Forgejo\'s refusal of a workflow it does not know', async () => {
    let message = ''

    await withFakeTea({ issues: [], workflows: [] }, async () => {
      message = await refusal(dispatch(['nope.yml', ...REPO]))
    })

    expect(message).toContain('workflow "nope.yml" is not found')
  })

  test('refuses a workflow that is no file name, an input without =, and --timeout without --wait', async () => {
    expect(await refusal(dispatch(['apps', ...REPO]))).toContain('such as test.yml')
    expect(await refusal(dispatch(['apps.yml', '-i', 'target', ...REPO]))).toContain('key=value')
    expect(await refusal(dispatch(['apps.yml', '-t', '5', ...REPO]))).toContain('go with --wait')
  })
})
