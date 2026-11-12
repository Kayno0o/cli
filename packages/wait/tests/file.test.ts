import { appendFileSync, chmodSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { waitforHarness } from './waitfor'

const { dir, log, waitfor } = waitforHarness()

describe('waitfor --file', () => {
  test('waits for the file to exist and for a line written later, colours stripped', async () => {
    const path = join(dir(), 'app.log')
    const result = await waitfor(['-f', path, '-u', '^ready on \\d+', '-t', '5s'], async () => {
      await Bun.sleep(400)
      writeFileSync(path, 'booting\n')
      await Bun.sleep(300)
      appendFileSync(path, '\u001B[32mready\u001B[0m on 8000\nafter\n')
    })

    expect(result).toEqual({ code: 0, out: 'app.log:2: ready on 8000\n'.replace('app.log', path), err: '' })
  })

  test('a --file that is a folder or unreadable is a usage error, exit 2, not the exit of a --fail line', async () => {
    const unreadable = log('secret\n')

    chmodSync(unreadable, 0o000)

    // root reads a file whatever its mode, as CI runs
    for (const path of process.getuid?.() === 0 ? [dir()] : [dir(), unreadable]) {
      const result = await waitfor(['-f', path, '-u', 'x', '-t', '2s'])

      expect(result.code).toBe(2)
      expect(result.err).toContain('--file')
    }
  })

  test('matches a line already in the file at once', async () => {
    const path = log('a\nServer listening\n')

    expect((await waitfor(['--file', path, '--until', 'listening'])).out).toBe(`${path}:2: Server listening\n`)
  })

  test('--json prints met, ms and the matched line, the progress going to stderr', async () => {
    const path = log('a\nServer listening\n')
    const result = await waitfor(['--file', path, '--until', 'listening', '--json'])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toEqual({ met: true, ms: expect.any(Number), line: { number: 2, text: 'Server listening' }, conditions: [{ name: `${path} --until`, ms: expect.any(Number) }] })
    expect(result.err).toBe(`${path}:2: Server listening\n`)
  })

  test('--quiet takes the same wait without the live progress line', async () => {
    const path = log('a\nServer listening\n')

    expect(await waitfor(['--file', path, '--until', 'listening', '--quiet'])).toEqual({ code: 0, out: `${path}:2: Server listening\n`, err: '' })
  })

  test('--json on a --fail line prints met false and that line, exiting 1', async () => {
    const result = await waitfor(['-f', log('boot\nFATAL: no db\n'), '-u', 'ready', '-e', 'FATAL', '--json'])

    expect(result.code).toBe(1)
    expect(JSON.parse(result.out)).toEqual({ met: false, ms: expect.any(Number), line: { number: 2, text: 'FATAL: no db' } })
  })

  test('ends with 1 on a --fail line, printing the lines around it', async () => {
    const path = log(`${Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n')}\nFATAL: no database\n  at connect\n  at boot\n`)
    const result = await waitfor(['-f', path, '-u', 'ready', '-e', 'FATAL', '-t', '5s'])

    expect(result.code).toBe(1)
    expect(result.out).toBe('')
    expect(result.err).toContain(`waitfor: ${path}:9 matched --fail after`)
    expect(result.err).toContain('   4  line 4\n')
    expect(result.err).toContain('   8  line 8\n>  9  FATAL: no database\n  10    at connect\n  11    at boot\n')
    expect(result.err).not.toContain('line 3')
  })

  test('a --until line before the --fail one wins', async () => {
    expect((await waitfor(['-f', log('ready\nFATAL\n'), '-u', 'ready', '-e', 'FATAL'])).code).toBe(0)
  })

  test('ends with 2 on a timeout, printing the last lines', async () => {
    const path = log('one\ntwo\n')
    const result = await waitfor(['-f', path, '-u', 'ready', '-t', '600ms'])

    expect(result.code).toBe(2)
    expect(result.err).toBe(`error: waitfor: gave up after 0.6s: no line of ${path} matched --until\nlast lines of ${path}:\n  1  one\n  2  two\n`)
  })

  test('says when the file never appeared', async () => {
    expect((await waitfor(['-f', join(dir(), 'none.log'), '-u', 'x', '-t', '300ms'])).err).toContain('none.log does not exist')
  })
})

describe('waitfor --file rotation', () => {
  test('starts over when the file is replaced by one at least as large', async () => {
    const path = join(dir(), 'app.log')

    writeFileSync(path, 'old line one\nold line two\n')

    const result = await waitfor(['-f', path, '-u', '^fresh', '-t', '5s'], async () => {
      await Bun.sleep(600)
      writeFileSync(join(dir(), 'new.log'), 'fresh start of the new file, longer\nmore\n')
      renameSync(join(dir(), 'new.log'), path)
    })

    expect(result.code).toBe(0)
    expect(result.out).toContain('fresh start')
  })

  test('reads a large file in slices, and cuts a very long line before matching it', async () => {
    const path = join(dir(), 'big.log')

    writeFileSync(path, `${'x'.repeat(3_000_000)}\nready\n`)

    const result = await waitfor(['-f', path, '-u', '^ready', '-t', '5s'])

    expect(result.code).toBe(0)
    expect(result.out).toBe(`${path}:2: ready\n`)
  })
})
