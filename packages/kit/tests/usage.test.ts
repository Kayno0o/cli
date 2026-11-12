import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runCli } from '../src/cli'
import { tempDirs } from '../src/test'
import { flagNames, noteUsageError, readUsage, recordUsage, summarizeUsage, usageEntry, usagePath, usageRecorded } from '../src/usage'

const temp = tempDirs()

describe('flagNames', () => {
  test('drops dash-prefixed arguments that are not option names', () => {
    expect(flagNames(['-secret', '--Token=abc', '-ab', '--ok', '-x'])).toEqual(['--ok', '-x'])
  })

  test('an empty or relative XDG_STATE_HOME is ignored', () => {
    expect(usagePath({ XDG_STATE_HOME: '' })).toBe(usagePath({}))
    expect(usagePath({ XDG_STATE_HOME: 'rel' })).toBe(usagePath({}))
    expect(usagePath({ XDG_STATE_HOME: '/abs' })).toStartWith('/abs/')
  })

  test('keeps flag names only, never values or arguments, and stops at --', () => {
    expect(flagNames(['query', '--limit=5', '-n', '3', 'select secret', '--json', '--', '--after'])).toEqual(['--limit', '-n', '--json'])
  })
})

describe('usageEntry', () => {
  test('names the unknown option of a usage error once', () => {
    noteUsageError('ft board: unknown option \'--nope=token\'')

    expect(usageEntry('ft', 'board', ['--nope=token'], 2, { now: new Date(0) })).toEqual({ at: '1970-01-01T00:00:00.000Z', bin: 'ft', command: 'board', flags: ['--nope'], code: 2, unknown: '--nope' })
    expect(usageEntry('ft', 'board', [], 2).unknown).toBeUndefined()
  })

  test('keeps how long the run took in whole milliseconds', () => {
    expect(usageEntry('code', 'hotspots', [], 0, { ms: 5470.6 }).ms).toBe(5471)
  })
})

describe('recordUsage', () => {
  test('appends a line under the state folder, 0600', () => {
    const state = temp('usage-state-')
    const env = { XDG_STATE_HOME: state }

    recordUsage(usageEntry('ft', 'board', ['--json'], 0, { now: new Date(0) }), env)
    recordUsage(usageEntry('db', undefined, [], 1, { now: new Date(0) }), env)

    const lines = readFileSync(usagePath(env), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { bin: string })

    expect(lines.map(line => line.bin)).toEqual(['ft', 'db'])
    expect(usagePath(env)).toBe(join(state, 'kaynooo-cli', 'usage.jsonl'))
  })

  test('is off under test, and with KAYNOOO_CLI_NO_USAGE set', () => {
    expect(usageRecorded({ NODE_ENV: 'test' })).toBe(false)
    expect(usageRecorded({ KAYNOOO_CLI_NO_USAGE: '1' })).toBe(false)
    expect(usageRecorded({ KAYNOOO_CLI_NO_USAGE: '0' })).toBe(true)
    expect(usageRecorded({})).toBe(true)
  })

  test('writes nothing when off', async () => {
    const env = { XDG_STATE_HOME: temp('usage-off-'), KAYNOOO_CLI_NO_USAGE: '1' }

    recordUsage(usageEntry('ft', undefined, [], 0), env)

    expect(await readUsage(usagePath(env))).toEqual([])
  })
})

describe('summarizeUsage', () => {
  test('counts runs per bin and the unknown options by frequency', () => {
    const at = new Date(0).toISOString()
    const summary = summarizeUsage([
      { at, bin: 'code', command: 'hotspots', flags: ['-n'], code: 2, unknown: '-n' },
      { at, bin: 'code', command: 'hotspots', flags: ['-n'], code: 2, unknown: '-n' },
      { at, bin: 'code', flags: [], code: 0 },
      { at, bin: 'ft', flags: [], code: 1 },
    ])

    expect(summary.runs).toBe(4)
    expect(summary.bins).toEqual([{ bin: 'code', runs: 3, failed: 0, usageErrors: 2 }, { bin: 'ft', runs: 1, failed: 1, usageErrors: 0 }])
    expect(summary.commands).toEqual([{ bin: 'code', command: 'hotspots', runs: 2, failed: 0, usageErrors: 2 }])
    expect(summary.usageErrors).toEqual([{ bin: 'code', command: 'hotspots', unknown: '-n', count: 2 }])
  })

  test('gives each command its median and p90 duration, slowest first, leaving out untimed runs and usage errors', () => {
    const at = new Date(0).toISOString()
    const run = (bin: string, ms: number, code = 0, command?: string) => ({ at, bin, ...command === undefined ? {} : { command }, flags: [], code, ms })
    const summary = summarizeUsage([
      ...[100, 200, 300, 400, 500, 600, 700, 800, 900, 30_000].map(ms => run('code', ms, 0, 'hotspots')),
      run('code', 90_000, 2, 'hotspots'),
      run('gst', 50),
      run('gst', 70, 1),
      { at, bin: 'gst', flags: [], code: 0 },
    ])

    expect(summary.durations).toEqual([{ bin: 'code', command: 'hotspots', runs: 10, median: 500, p90: 900 }, { bin: 'gst', runs: 2, median: 50, p90: 70 }])
  })

  test('never keeps the message of a usage error, which carries the value it refused', () => {
    noteUsageError('origin https://me:secret@gitlab.com/x/y.git is not on a Forgejo')

    expect(JSON.stringify(usageEntry('ft', 'board', [], 2))).not.toContain('secret')
  })
})

describe('runCli', () => {
  test('records the run with its command and flags when usage is on', async () => {
    const state = temp('usage-run-')
    const before = { ...process.env }

    process.env.XDG_STATE_HOME = state
    process.env.NODE_ENV = 'production'

    try {
      const code = await runCli({ name: 'demo', version: '1.0.0', about: 'x', commands: { go: { summary: 'go', run: async () => Promise.resolve(0) } } }, ['go', '--fast'])

      expect(code).toBe(0)
      expect((await readUsage(usagePath({ XDG_STATE_HOME: state })))[0]).toMatchObject({ bin: 'demo', command: 'go', flags: ['--fast'], code: 0 })
    }
    finally {
      for (const name of ['XDG_STATE_HOME', 'NODE_ENV']) {
        if (before[name] === undefined)
          delete process.env[name]
        else
          process.env[name] = before[name]
      }
    }
  })
})
