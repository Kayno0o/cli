import type { Report } from '../src/dlog'
import { knownSecrets } from '@kaynooo/cli-env/mask'
import { describe, expect, test } from 'bun:test'
import { dlog, errorLines, healthOf, isUp, needsLook, windowOf, withoutKeys } from '../src/dlog'

const report = (over: Partial<Report>): Report => ({ key: 'php', state: 'running', health: '', status: 'Up', errors: [], tail: [], windowFull: false, windowFrom: undefined, unreadable: undefined, fine: true, down: false, unhealthy: false, ...over })

describe('errorLines', () => {
  test('keeps the error lines only, a repeated message once with its count and its latest wording', () => {
    const log = [
      '2026-11-03T10:00:01Z INFO started',
      '2026-11-03T10:00:02Z ERROR connection refused to db:5432 (attempt 1)',
      '2026-11-03T10:00:03Z INFO retrying',
      '2026-11-03T10:00:04Z ERROR connection refused to db:5432 (attempt 2)',
      '2026-11-03T10:00:05Z FATAL out of memory',
    ].join('\n')

    expect(errorLines(log, 5)).toEqual([
      { line: '2026-11-03T10:00:04Z ERROR connection refused to db:5432 (attempt 2)', count: 2 },
      { line: '2026-11-03T10:00:05Z FATAL out of memory', count: 1 },
    ])
  })

  test('keeps the last lines when there are more than the limit, and none from a quiet log', () => {
    const log = ['error one', 'error two', 'error three'].join('\n')

    expect(errorLines(log, 2).map(each => each.line)).toEqual(['error two', 'error three'])
    expect(errorLines('all good\nlistening on 80', 5)).toEqual([])
  })

  test('masks a secret in the line', () => {
    const [found] = errorLines('error: login failed with password=hunter2secret', 5)

    expect(found?.line).not.toContain('hunter2secret')
  })

  test('masks a bare value of the folder\'s .env, which no pattern finds', () => {
    const known = knownSecrets([['DB_PASSWORD', 'zq81vkw0pLm']])
    const [found] = errorLines('error: auth failed for zq81vkw0pLm', 5, known)

    expect(found?.line).not.toContain('zq81vkw0pLm')
  })

  test.each(['0x10', '1e1', '0'])('refuses --lines %s, which is not a plain whole number from 1', (lines) => {
    expect(dlog(['--lines', lines])).rejects.toThrow('--lines takes a whole number from 1')
  })

  test('strips colour codes and cuts a very long line', () => {
    const [found] = errorLines(`\u001B[31merror: ${'x'.repeat(400)}\u001B[0m`, 5)

    expect(found?.line.startsWith('error:')).toBe(true)
    expect(found?.line.length).toBeLessThanOrEqual(220)
  })
})

describe('errorLines with another filter', () => {
  const log = 'WARN cache is cold\nERROR boom\nINFO fine\nGET /x 503'

  test('--level warn adds the warnings', () => {
    expect(errorLines(log, 5, undefined, /\b(?:error|warn)\b/i).map(each => each.line)).toEqual(['WARN cache is cold', 'ERROR boom'])
  })

  test('a regex replaces the error words', () => {
    expect(errorLines(log, 5, undefined, /\b5\d\d\b/).map(each => each.line)).toEqual(['GET /x 503'])
  })

  test('refuses a --grep that is not a regex', () => {
    expect(dlog(['--grep', '('])).rejects.toThrow('--grep')
  })
})

describe('needsLook', () => {
  const old = report({ errors: [{ line: 'error old', count: 1 }] })
  const sick = report({ health: 'unhealthy', fine: false, unhealthy: true })
  const gone = report({ state: 'exited', fine: false, down: true })

  test('every cause fails by default, so an old error keeps a gate red', () => {
    const all = new Set(['down', 'unhealthy', 'errors'] as const)

    expect([old, sick, gone, report({})].map(each => needsLook(each, all))).toEqual([true, true, true, false])
  })

  test('--fail-on down ignores errors and health', () => {
    const failOn = new Set(['down'] as const)

    expect([old, sick, gone].map(each => needsLook(each, failOn))).toEqual([false, false, true])
  })

  test('--fail-on unhealthy and errors each name their own cause, unreadable logs counting as down and errors', () => {
    expect([old, sick, gone].map(each => needsLook(each, new Set(['unhealthy'] as const)))).toEqual([false, true, false])
    expect([old, sick, gone].map(each => needsLook(each, new Set(['errors'] as const)))).toEqual([true, false, false])
    expect(needsLook(report({ unreadable: 'no such service' }), new Set(['down'] as const))).toBe(true)
  })

  test('a service that ended with code 0 is up', () => {
    expect(isUp('exited', { Service: 'migrate', State: 'exited', Status: 'Exited (0)', ExitCode: 0 })).toBe(true)
    expect(isUp('exited', undefined)).toBe(false)
  })
})

describe('healthOf', () => {
  test('reads the health compose reports, else the one in the status, and calls a running service without a check fine', () => {
    expect(healthOf('running', { Service: 'a', State: 'running', Status: 'Up', Health: 'unhealthy' })).toEqual({ health: 'unhealthy', fine: false })
    expect(healthOf('running', { Service: 'a', State: 'running', Status: 'Up 2 minutes (healthy)' })).toEqual({ health: 'healthy', fine: true })
    expect(healthOf('running', { Service: 'a', State: 'running', Status: 'Up' })).toEqual({ health: '', fine: true })
    expect(healthOf('exited', undefined).fine).toBe(false)
  })
})

describe('withoutKeys', () => {
  test('drops a private key block from its BEGIN line to its END line', () => {
    const lines = ['error before', '-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJB', '-----END RSA PRIVATE KEY-----', 'error after']

    expect(withoutKeys(lines)).toEqual(['error before', 'error after'])
  })
})

describe('healthOf for a finished service', () => {
  test('counts one that exited with code 0 as fine, and one that failed as not', () => {
    expect(healthOf('exited', { Service: 'migrate', State: 'exited', Status: 'Exited (0)', ExitCode: 0 }).fine).toBe(true)
    expect(healthOf('exited', { Service: 'migrate', State: 'exited', Status: 'Exited (1)', ExitCode: 1 }).fine).toBe(false)
    expect(healthOf('running', { Service: 'a', State: 'running', Status: 'Up', Health: 'starting' }).fine).toBe(false)
  })
})

describe('errorLines with the wider error words', () => {
  test('finds exception classes, errno names, counts and crashes', () => {
    for (const line of ['java.lang.NullPointerException at Main', 'RuntimeException: boom', 'connect ECONNREFUSED 10.0.0.2:5432', 'listen EADDRINUSE: :::80', 'container OOMKilled', 'net::ERR_CONNECTION_RESET', '3 errors found', 'Segmentation fault (core dumped)', 'unhandled rejection', 'uncaught TypeError'])
      expect(errorLines(line, 5).map(each => each.line), line).toEqual([line])
  })

  test('leaves counts of zero and config keys alone', () => {
    for (const line of ['0 errors', 'no errors found', 'error_reporting = E_ALL', 'enabled eager mode'])
      expect(errorLines(line, 5), line).toEqual([])
  })
})

describe('windowOf', () => {
  test('is full once the log has as many lines as the tail limit, from the first timestamp', () => {
    expect(windowOf('2026-11-03T10:00:01Z a\nb\nc\n', 3)).toEqual({ full: true, from: '2026-11-03T10:00:01Z' })
    expect(windowOf('b\nc\n', 3)).toEqual({ full: false, from: undefined })
    expect(windowOf('a\nb\nc', 3).from).toBeUndefined()
  })
})
