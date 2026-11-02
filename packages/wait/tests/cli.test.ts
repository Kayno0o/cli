import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'
import { waitforHarness } from './waitfor'

const { waitfor } = waitforHarness()

describe('waitfor usage', () => {
  test('prints its version and its help', async () => {
    expect((await waitfor(['--version'])).out.trim()).toBe(version)
    expect((await waitfor(['--help'])).out).toContain('waitfor [options]')
  })

  test('refuses what cannot be waited for', async () => {
    expect((await waitfor([])).err).toContain('give --until with --file, --port, --url or --pid')
    expect((await waitfor(['-u', 'x'])).err).toContain('--file needs one of them')
    expect((await waitfor(['-f', 'a.log', '-p', '80'])).err).toContain('--file needs one of them')
    expect((await waitfor(['-f', 'a.log', '-u', '('])).err).toContain('--until is no valid regular expression')
    expect((await waitfor(['-p', '70000'])).err).toContain('up to 65535')
    expect((await waitfor(['-p', '80', '-t', 'soon'])).err).toContain('--timeout takes a duration')
    expect((await waitfor(['--url', 'nope'])).code).toBe(2)
  })

  test('exits 2 on a usage error', async () => {
    const results = await Promise.all([[], ['-H', 'db', '--url', 'http://x'], ['-p', '80', 'extra'], ['-p', 'eighty'], ['--pid', '-1']].map(async args => waitfor(args)))

    expect(results.map(({ code }) => code)).toEqual([2, 2, 2, 2, 2])
    expect(results[1]?.err).toContain('--host goes with --port')
    expect(results[2]?.err).toContain('unexpected argument extra')
  })
})
