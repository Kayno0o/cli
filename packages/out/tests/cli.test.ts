import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { version } from '../package.json'
import { cleanLogs } from '../src/logs'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const LOG_PATH = /full log: ([^\s\]]+)/

// Every temp folder of the file, removed once it ends.
const made: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))

  made.push(dir)

  return dir
}

afterAll(() => {
  for (const dir of made)
    rmSync(dir, { recursive: true, force: true })
})

const RUNTIME = temp('out-runtime-')
const ENV = { ...process.env, XDG_RUNTIME_DIR: RUNTIME }

function out(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe', env: ENV })

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

  test('keeps the log private to the user', () => {
    const path = LOG_PATH.exec(out('-n', '5', '--', 'seq', '1', '60').out)?.[1] ?? ''

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    expect(path.startsWith(RUNTIME)).toBe(true)
  })

  test('streams output past the memory it keeps to the log, and still folds', () => {
    const result = out('--', 'sh', '-c', 'head -c 6000000 /dev/zero | tr "\\0" a | fold -w 80; echo THE-END')
    const path = LOG_PATH.exec(result.out)?.[1] ?? ''

    expect(result.code).toBe(0)
    expect(result.out).toContain('THE-END')
    expect(result.out).toContain('left out of memory')
    expect(statSync(path).size).toBeGreaterThan(6_000_000)
  })

  test('forwards a signal to the command, exiting with its code', async () => {
    const child = Bun.spawn([process.execPath, CLI, '--', 'sh', '-c', 'sleep 30 & wait'], { stdout: 'pipe', stderr: 'pipe', env: ENV })

    await Bun.sleep(500)
    child.kill('SIGTERM')

    expect(await child.exited).toBe(143)
  })

  test('takes the threshold with -n', () => {
    expect(out('-n', '5', '--', 'seq', '1', '6').out).toContain('full log:')
    expect(out('-n', '6', '--', 'seq', '1', '6').out).toBe('1\n2\n3\n4\n5\n6\n')
    expect(out('-n', 'x', '--', 'seq', '1', '6').code).toBe(2)
  })
})

describe('out around a step that runs in a compose service', () => {
  test('folds the output of the docker compose exec line check builds, keeping the failure lines and the exit code', () => {
    const bin = temp('out-docker-')
    const script = ['#!/bin/sh', 'shift 2', 'while true; do case "$1" in -T) shift;; -w|-e) shift 2;; *) break;; esac; done', 'shift', 'exec "$@"', ''].join('\n')

    writeFileSync(join(bin, 'docker'), script)
    chmodSync(join(bin, 'docker'), 0o755)

    const inner = 'i=0; while [ $i -lt 400 ]; do echo "row $i of the table is fine"; i=$((i+1)); done; echo "src/a.ts(1,7): error TS2322: bad" >&2; exit 1'
    const line = `cd ${bin} && docker compose exec -T -w /app -e NO_COLOR=1 -e FORCE_COLOR=0 app sh -c '${inner}'`
    const result = Bun.spawnSync([process.execPath, CLI, '--', 'sh', '-c', line], { stdout: 'pipe', stderr: 'pipe', env: { ...ENV, PATH: `${bin}:${process.env.PATH}` } })
    const text = result.stdout.toString()
    const path = LOG_PATH.exec(text)?.[1]

    expect(result.exitCode).toBe(1)
    expect(text.split('\n').length).toBeLessThan(120)
    expect(text).toContain('src/a.ts(1,7): error TS2322: bad')
    expect(readFileSync(path ?? '', 'utf8')).toContain('row 399 of the table is fine')
  })
})

describe('cleanLogs', () => {
  test('removes the logs older than a day and keeps the recent ones', async () => {
    const dir = temp('out-clean-')
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
