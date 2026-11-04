import type { CiWait } from '../src'
import { describe, expect, test } from 'bun:test'
import { Exit, isPermanentFailure, runTool, waitForCi } from '../src'
import { capture } from '../src/test'

function wait(overrides: Partial<CiWait<string>>): CiWait<string> {
  return {
    tool: 'x ci',
    short: 'abc1234',
    giveUpMs: 2000,
    noneMs: 50,
    stalledMs: 50,
    pollMs: 1,
    noneMessage: 'nothing covers it',
    covering: async () => 'done',
    finished: found => found === 'done',
    key: found => found,
    announce: () => undefined,
    links: found => `link-${found}`,
    settle: async () => undefined,
    ...overrides,
  }
}

async function refusal(pending: Promise<unknown>): Promise<string> {
  try {
    await pending

    return ''
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('waitForCi', () => {
  test('returns what covers the commit once finished, announcing it once', async () => {
    const seen: string[] = []
    const polls = ['running', 'running', 'done']

    const found = await waitForCi(wait({ covering: async () => polls.shift(), announce: found => seen.push(found) }))

    expect(found).toBe('done')
    expect(seen).toEqual(['running', 'done'])
  })

  test('polls again after a failed poll', async () => {
    let calls = 0

    const { result, err } = await capture(async () => waitForCi(wait({
      covering: async () => {
        calls++

        if (calls < 3)
          throw new Error('network down')

        return 'done'
      },
    })))

    expect(result).toBe('done')
    expect(err).toContain('x ci: network down, polling again')
  })

  test('quiet leaves the retry warnings out', async () => {
    let calls = 0

    const { result, err } = await capture(async () => waitForCi(wait({
      quiet: true,
      covering: async () => {
        calls++

        if (calls < 3)
          throw new Error('network down')

        return 'done'
      },
    })))

    expect(result).toBe('done')
    expect(err).toBe('')
  })

  test('fails at once on a refusal, a 404 or a missing binary instead of polling to the timeout', async () => {
    for (const error of [new Exit('not on the branch', 2), new Error('tea api x: The target couldn\'t be found.'), new Error('glab api x: glab: 401 Unauthorized (HTTP 401)')]) {
      let calls = 0
      const message = await refusal(waitForCi(wait({
        covering: async () => {
          calls++

          throw error
        },
      })))

      expect(message).toBe(error.message)
      expect(calls).toBe(1)
    }

    const missing = await refusal(waitForCi(wait({
      covering: async () => {
        await runTool('nope', ['definitely-not-a-binary-here'])

        return 'done'
      },
    })))

    expect(missing).toContain('definitely-not-a-binary-here')
  })

  test('retries a stall lookup that failed and goes on to finish', async () => {
    const polls = ['running', 'running', 'done']
    let lookups = 0

    const { result, err } = await capture(async () => waitForCi(wait({
      covering: async () => polls.shift(),
      stall: async () => {
        lookups++

        throw new Error('jobs unreadable')
      },
    })))

    expect(result).toBe('done')
    expect(lookups).toBe(2)
    expect(err).toContain('jobs unreadable')
  })

  test('fails on a certain stall at once and on an uncertain one after stalledMs', async () => {
    expect(await refusal(waitForCi(wait({ covering: async () => 'running', stall: async () => ({ message: 'no runner', certain: true }) })))).toBe('no runner')
    expect(await refusal(waitForCi(wait({ covering: async () => 'running', stall: async () => ({ message: 'slow runner' }) })))).toBe('slow runner')
  })

  test('gives up when nothing covers the commit, and on the timeout', async () => {
    expect(await refusal(waitForCi(wait({ covering: async () => undefined })))).toBe('nothing covers it')
    expect(await refusal(waitForCi(wait({ covering: async () => 'running', giveUpMs: 100 })))).toBe('CI has not finished on abc1234 in 0.1s: link-running')
  })
})

describe('isPermanentFailure', () => {
  test('is true for an authorisation or missing-route answer and a missing binary, false for a network error', async () => {
    expect(isPermanentFailure(new Error('tea api x: token is required'))).toBe(true)
    expect(isPermanentFailure(new Error('glab api x: glab: 403 Forbidden (HTTP 403)'))).toBe(true)

    let missing: unknown

    try {
      await runTool('nope', ['definitely-not-a-binary-here'])
    }
    catch (error) {
      missing = error
    }

    expect(isPermanentFailure(missing)).toBe(true)
    expect(isPermanentFailure(new Error('tea api x: connection reset'))).toBe(false)
    expect(isPermanentFailure(new Error('tea api x: no answer in 1.0m'))).toBe(false)
  })
})

describe('runTool', () => {
  test('returns both streams and the code, and throws naming the command when it outlives the timeout', async () => {
    const ran = await runTool('sh', ['sh', '-c', 'echo out; echo err >&2; exit 3'])

    expect(ran).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n' })
    expect(await refusal(runTool('sleeper', ['sleep', '5'], { timeoutMs: 100 }))).toBe('sleeper: no answer in 0.1s')
  })
})
