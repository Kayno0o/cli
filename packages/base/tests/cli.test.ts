import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'bun:test'
import { version } from '../package.json'
import { runsInContainer } from '../src/worktree'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname

let repo = ''

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })

  return result.stdout.toString().trim()
}

function base(args: string[], cwd = repo) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

function file(name: string, text: string): void {
  mkdirSync(join(repo, name, '..'), { recursive: true })
  writeFileSync(join(repo, name), text)
}

function commit(message: string): void {
  git('add', '-A')
  git('commit', '-q', '-m', message)
}

function worktrees(): number {
  return git('worktree', 'list').split('\n').length
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'base-test-')))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  file('.gitignore', 'node_modules/\n.env.local\ndist/\n')
  file('a.txt', 'first\n')
  file('api/b.txt', 'api first\n')
  commit('first')
  file('a.txt', 'second\n')
  commit('second')
})

describe('base', () => {
  test('prints its version and its help', () => {
    expect(base(['--version']).out.trim()).toBe(version)
    expect(base(['--help']).out).toContain('base [--ref <rev>]')
  })

  test('runs at HEAD, leaving the working tree and no worktree behind', () => {
    file('a.txt', 'edited\n')
    const result = base(['--', 'cat', 'a.txt'])

    expect(result.code).toBe(0)
    expect(result.out).toBe('second\n')
    expect(result.err).toBe(`base: ran at HEAD (${git('rev-parse', '--short=7', 'HEAD')}), exit 0\n`)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('edited\n')
    expect(worktrees()).toBe(1)
  })

  test('runs at --ref and exits with the command\'s code, one spaced argument going through sh', () => {
    expect(base(['--ref', 'HEAD~1', '--', 'cat', 'a.txt']).out).toBe('first\n')
    expect(base(['--', 'sh', '-c', 'exit 3']).code).toBe(3)

    const line = base(['--', 'cat a.txt | tr a-z A-Z; exit 4'])

    expect(line.out).toBe('SECOND\n')
    expect(line.code).toBe(4)
    expect(worktrees()).toBe(1)
  })

  test('runs in the caller\'s folder of the worktree', () => {
    file('api/b.txt', 'api edited\n')

    expect(base(['--', 'cat', 'b.txt'], join(repo, 'api')).out).toBe('api first\n')
  })

  test('--keep copies working-tree files over', () => {
    file('api/new.test.txt', 'new test\n')
    file('a.txt', 'edited\n')
    const result = base(['--keep', 'new.test.txt', '--', 'cat', 'new.test.txt', '../a.txt'], join(repo, 'api'))

    expect(result.out).toBe('new test\nsecond\n')
  })

  test('links ignored env files and dependency folders, deleting nothing through them', () => {
    file('.env.local', 'KEY=local\n')
    file('node_modules/dep/index.txt', 'dep\n')
    file('dist/out.txt', 'built\n')

    const linked = base(['--', 'sh', '-c', 'cat .env.local node_modules/dep/index.txt; test -e dist/out.txt || echo no dist'])

    expect(linked.out).toBe('KEY=local\ndep\nno dist\n')
    expect(existsSync(join(repo, 'node_modules/dep/index.txt'))).toBe(true)
    expect(existsSync(join(repo, '.env.local'))).toBe(true)
    expect(base(['--no-link', '--', 'test', '-e', 'node_modules']).code).toBe(1)
  })

  test('points a workspace link of node_modules at the worktree, not the main checkout', () => {
    file('packages/kit/index.txt', 'old kit\n')
    commit('add kit')
    file('packages/kit/index.txt', 'new kit\n')
    mkdirSync(join(repo, 'node_modules/@scope'), { recursive: true })
    symlinkSync('../../packages/kit', join(repo, 'node_modules/@scope/kit'))
    file('node_modules/dep/index.txt', 'dep\n')

    const result = base(['--', 'sh', '-c', 'cat node_modules/@scope/kit/index.txt node_modules/dep/index.txt'])

    expect(result.out).toBe('old kit\ndep\n')
    expect(readFileSync(join(repo, 'packages/kit/index.txt'), 'utf8')).toBe('new kit\n')
    expect(existsSync(join(repo, 'node_modules/dep/index.txt'))).toBe(true)
  })

  test('keeps a --keep file whose name starts with two dots', () => {
    file('..foo', 'dots\n')

    expect(base(['--keep', '..foo', '--', 'cat', '..foo']).out).toBe('dots\n')
  })

  test('refuses a --keep going through a committed symlink, writing nothing outside', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'base-outside-')))

    symlinkSync(outside, join(repo, 'evil'))
    commit('add a symlink')
    rmSync(join(repo, 'evil'))
    file('evil/file', 'payload\n')

    const result = base(['--keep', 'evil/file', '--', 'true'])

    expect(result.code).toBe(2)
    expect(result.err).toContain('symlink')
    expect(existsSync(join(outside, 'file'))).toBe(false)
  })

  test('takes a ref starting with a dash as a ref, not an option', () => {
    expect(base(['--ref=--all', '--', 'true']).err).toContain('no commit --all in this repository')
  })

  test('removes the worktree when interrupted', async () => {
    const proc = Bun.spawn([process.execPath, CLI, '--', 'sleep', '30'], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })

    for (let i = 0; i < 100 && worktrees() === 1; i++)
      await Bun.sleep(50)

    expect(worktrees()).toBe(2)
    await Bun.sleep(200)
    proc.kill('SIGTERM')

    expect(await proc.exited).toBe(143)
    expect(worktrees()).toBe(1)
  })

  test('refuses an unknown ref, a missing or outside --keep, and no command', () => {
    expect(base(['--ref', 'nope', '--', 'true']).err).toContain('no commit nope in this repository')
    expect(base(['--keep', 'missing.txt', '--', 'true']).err).toContain('--keep missing.txt: no such file')
    expect(base(['--keep', '..', '--', 'true']).err).toContain('--keep .. is outside the repository')
    expect(base(['--ref', 'HEAD']).code).toBe(2)
    expect(worktrees()).toBe(1)
  })

  test('refuses a command run in a compose container, which mounts the main checkout', () => {
    const result = base(['--', 'docker', 'compose', 'exec', '-T', 'php', 'vendor/bin/phpunit'])

    expect(result.code).toBe(2)
    expect(result.err).toContain('mounts the main checkout')
  })
})

describe('runsInContainer', () => {
  test('spots exec and run through docker compose, docker-compose and docker exec', () => {
    expect(runsInContainer(['docker', 'compose', '-f', 'compose.yaml', 'exec', 'php', 'bin/phpunit'])).toBe(true)
    expect(runsInContainer(['docker-compose', 'run', '--rm', 'php', 'true'])).toBe(true)
    expect(runsInContainer(['sh', '-c', 'cd api && docker exec app phpunit'])).toBe(true)
    expect(runsInContainer(['sh', '-c', 'docker compose up -d && bun run test'])).toBe(false)
    expect(runsInContainer(['bun', 'test'])).toBe(false)
  })
})
