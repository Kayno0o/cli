import { knownSecrets } from '@kaynooo/cli-env/mask'
import { describe, expect, test } from 'bun:test'
import { dlog, errorLines, healthOf, withoutKeys } from '../src/dlog'

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
