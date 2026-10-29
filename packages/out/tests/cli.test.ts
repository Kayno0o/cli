import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'
import { cleanLogs } from '../src/logs'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const LOG_PATH = /full log: ([^\s\]]+)/

function out(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('out', () => {
  test('prints its version and its help', () => {
    expect(out('--version').out.trim()).toBe(version)
    expect(out('--help').out).toContain('out [-n <lines>] -- <command>')
  })

  test('refuses to run without a command', () => {
    const result = out()

    expect(result.code).toBe(2)
    expect(result.err).toContain('give the command after --')
  })

  test('passes short output through byte for byte, stdout and stderr apart', () => {
    const result = out('--', 'sh', '-c', 'printf "a\\n  b \\n"; printf "oops\\n" >&2; printf "no newline"')

    expect(result.out).toBe('a\n  b \nno newline')
    expect(result.err).toBe('oops\n')
    expect(result.code).toBe(0)
  })

  test('exits with the wrapped command\'s code, short or long', () => {
    expect(out('--', 'sh', '-c', 'echo hi; exit 7').code).toBe(7)
    expect(out('--', 'sh', '-c', 'seq 1 500; exit 3').code).toBe(3)
    expect(out('--', 'sh', '-c', 'kill -TERM $$').code).toBe(143)
    expect(out('--', 'definitely-not-a-command').code).toBe(127)
  })

  test('folds long output, saving the full log where the header says', () => {
    const result = out('--', 'sh', '-c', 'i=0; while [ $i -lt 400 ]; do echo "row $i of the table is fine"; i=$((i+1)); done; echo "FAILED: boom" >&2')
    const path = LOG_PATH.exec(result.out)?.[1]

    expect(result.out.split('\n').length).toBeLessThan(120)
    expect(result.out).toContain('FAILED: boom')
    expect(path).toBeDefined()
    expect(readFileSync(path ?? '', 'utf8')).toContain('row 399 of the table is fine\nFAILED: boom\n')
  })

  test('takes the threshold with -n', () => {
    expect(out('-n', '5', '--', 'seq', '1', '6').out).toContain('full log:')
    expect(out('-n', '6', '--', 'seq', '1', '6').out).toBe('1\n2\n3\n4\n5\n6\n')
    expect(out('-n', 'x', '--', 'seq', '1', '6').code).toBe(2)
  })
})

describe('cleanLogs', () => {
  test('removes the logs older than a day and keeps the recent ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'out-clean-'))
    const old = join(dir, 'old.log')
    const recent = join(dir, 'recent.log')
    const now = Date.now()

    writeFileSync(old, 'x')
    writeFileSync(recent, 'x')
    utimesSync(old, new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000))
    await cleanLogs(dir, now)

    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  test('ignores a folder that does not exist', async () => {
    await cleanLogs(join(tmpdir(), 'out-missing-folder'))
  })
})
