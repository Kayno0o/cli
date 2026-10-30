import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname

let dir = ''

function sub(args: string[], stdin?: string) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: dir, stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

function file(name: string, text: string): string {
  writeFileSync(join(dir, name), text)

  return name
}

function read(name: string): string {
  return readFileSync(join(dir, name), 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sub-test-'))
})

describe('sub', () => {
  test('prints its version and its help', () => {
    expect(sub(['--version']).out.trim()).toBe(version)
    expect(sub(['--help']).out).toContain('sub [options] <file>...')
  })

  test('replaces one literal match and reports its line and diff stat', () => {
    file('a.ts', 'const a = 1\nconst b = a.b(1)\n')
    const result = sub(['--from', 'a.b(1)', '--to', 'a.c(2)', 'a.ts'])

    expect(result.code).toBe(0)
    expect(read('a.ts')).toBe('const a = 1\nconst b = a.c(2)\n')
    expect(result.out).toBe('a.ts: 1 replacement on line 2, +1 -1\n')
  })

  test('takes --from literally, regex characters and $ included', () => {
    file('a.ts', 'x.*$1\n')

    expect(sub(['-f', 'x.*$1', '-t', '$&y', 'a.ts']).code).toBe(0)
    expect(read('a.ts')).toBe('$&y\n')
  })

  test('writes nothing when --from matches nowhere, naming where its first line is', () => {
    file('a.ts', 'function a() {\n    return 1\n}\n')
    const result = sub(['--from', 'function a() {\n  return 1', '--to', 'x', 'a.ts'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('nothing written')
    expect(result.err).toContain('a.ts: matched 0 times, expected 1 (its first line is on line 1)')
    expect(read('a.ts')).toBe('function a() {\n    return 1\n}\n')
  })

  test('writes nothing when --from matches more often than expected, listing the lines', () => {
    file('a.ts', 'a\nb\na\n')
    const result = sub(['-f', 'a', '-t', 'c', 'a.ts'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('matched 2 times, expected 1 on lines 1, 3: add context to --from, or pass --count 2 or --all')
    expect(read('a.ts')).toBe('a\nb\na\n')
  })

  test('--count and --all accept several matches', () => {
    file('a.ts', 'a\nb\na\n')

    expect(sub(['-f', 'a', '-t', 'c', '-n', '2', 'a.ts']).out).toBe('a.ts: 2 replacements on lines 1, 3, +2 -2\n')
    expect(sub(['-f', 'c', '-t', 'd', '--all', 'a.ts']).code).toBe(0)
    expect(read('a.ts')).toBe('d\nb\nd\n')
    expect(sub(['-f', 'zzz', '-t', 'd', '--all', 'a.ts']).code).toBe(1)
  })

  test('checks every file before writing any', () => {
    file('a.ts', 'old\n')
    file('b.ts', 'new\n')
    const result = sub(['-f', 'old', '-t', 'new', 'a.ts', 'b.ts', 'missing.ts'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('b.ts: matched 0 times')
    expect(result.err).toContain('missing.ts: no such file')
    expect(read('a.ts')).toBe('old\n')
  })

  test('applies pairs from stdin in order, all or nothing', () => {
    file('a.ts', 'one\ntwo\n')
    const ok = sub(['--pairs', '-', 'a.ts'], JSON.stringify([{ from: 'one', to: 'uno' }, { from: 'uno\ntwo', to: 'both' }]))

    expect(ok.code).toBe(0)
    expect(read('a.ts')).toBe('both\n')

    const failed = sub(['-p', '-', 'a.ts'], JSON.stringify([{ from: 'both', to: 'x' }, { from: 'nowhere', to: 'y' }]))

    expect(failed.code).toBe(1)
    expect(failed.err).toContain('a.ts: pair 2: matched 0 times')
    expect(read('a.ts')).toBe('both\n')
  })

  test('refuses malformed pairs before touching a file', () => {
    file('a.ts', 'a\n')

    expect(sub(['-p', '-', 'a.ts'], '{').err).toContain('--pairs is no valid JSON')
    expect(sub(['-p', '-', 'a.ts'], '[{"from":"a"}]').err).toContain('pair 1: from and to must both be strings')
    expect(sub(['-p', '-', 'a.ts'], '[{"from":"a","to":"b","count":0}]').err).toContain('count takes a whole number from 1')
    expect(sub(['-p', '-', 'a.ts'], '[]').err).toContain('at least one')
  })

  test('--regex replaces with capture groups, ^ and $ per line', () => {
    file('a.ts', 'foo(1)\nfoo(22)\n')

    expect(sub(['-r', '-f', String.raw`^foo\((\d+)\)$`, '-t', 'bar($1)', '--all', 'a.ts']).code).toBe(0)
    expect(read('a.ts')).toBe('bar(1)\nbar(22)\n')
    expect(sub(['-r', '-f', '(', '-t', 'x', 'a.ts']).err).toContain('--from is no valid regular expression')
  })

  test('matches a --from typed with plain newlines in a CRLF file, keeping CRLF', () => {
    file('a.ts', 'a\r\nb\r\nc\r\n')

    expect(sub(['-f', 'a\nb', '-t', 'x\ny', 'a.ts']).code).toBe(0)
    expect(read('a.ts')).toBe('x\r\ny\r\nc\r\n')
  })

  test('--dry-run and --diff show the change without writing it', () => {
    file('a.ts', 'a\nb\n')
    const result = sub(['-f', 'b', '-t', 'c', '--dry-run', '--diff', 'a.ts'])

    expect(result.code).toBe(0)
    expect(result.out).toContain('--- a/a.ts\n+++ b/a.ts\n')
    expect(result.out).toContain('-b\n+c\n')
    expect(result.out).toContain('dry run: nothing written')
    expect(read('a.ts')).toBe('a\nb\n')
  })

  test('keeps the file\'s mode and its missing trailing newline', () => {
    file('run.sh', 'echo a')
    chmodSync(join(dir, 'run.sh'), 0o750)

    expect(sub(['-f', 'a', '-t', 'b', 'run.sh']).code).toBe(0)
    expect(read('run.sh')).toBe('echo b')
    expect(statSync(join(dir, 'run.sh')).mode & 0o777).toBe(0o750)
  })

  test('deletes with an empty --to', () => {
    file('a.ts', 'keep drop\n')

    expect(sub(['-f', ' drop', '-t', '', 'a.ts']).code).toBe(0)
    expect(read('a.ts')).toBe('keep\n')
  })

  test('refuses unclear arguments', () => {
    file('a.ts', 'a\n')

    expect(sub(['-f', 'a', 'a.ts']).err).toContain('give --from and --to')
    expect(sub(['-f', 'a', '-t', 'b']).err).toContain('give at least one file')
    expect(sub(['-f', 'a', '-t', 'b', '-n', '2', '--all', 'a.ts']).err).toContain('--count and --all exclude each other')
    expect(sub(['-f', '', '-t', 'b', 'a.ts']).err).toContain('--from is empty')
    expect(sub(['-p', '-', '-f', 'a', 'a.ts'], '[]').err).toContain('give either --pairs or --from and --to')
  })
})
