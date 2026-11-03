import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capture, tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { check } from '../src/check'
import { changedPaths, narrow, siblingTests } from '../src/narrow'

const temp = tempDirs()

process.env.XDG_RUNTIME_DIR = temp('narrow-runtime-')

function git(dir: string, ...args: string[]) {
  const ran = Bun.spawnSync(['git', ...args], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

  if (ran.exitCode !== 0)
    throw new Error(ran.stderr.toString())
}

function write(dir: string, path: string, text: string) {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), text)
}

// A committed repo with two sources and a test for one of them.
function repo(scripts: Record<string, string>): string {
  const dir = temp('narrow-repo-')

  write(dir, 'package.json', JSON.stringify({ scripts }))
  write(dir, 'src/a.ts', 'export const a = 1\n')
  write(dir, 'src/b.ts', 'export const b = 1\n')
  write(dir, 'tests/a.test.ts', 'export {}\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')

  return dir
}

describe('changedPaths', () => {
  test('lists staged, unstaged and untracked files, not a deleted one', async () => {
    const dir = repo({ lint: 'eslint' })

    write(dir, 'src/a.ts', 'changed\n')
    write(dir, 'src/new.ts', 'new\n')
    git(dir, 'rm', '-q', '--cached', 'src/b.ts')

    expect((await changedPaths(dir))?.toSorted()).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts'])
  })

  test('is undefined outside a repository', async () => {
    expect(await changedPaths(temp('narrow-none-'))).toBeUndefined()
  })
})

describe('siblingTests', () => {
  test('finds a test next to the source, in its tests folder or the package\'s', () => {
    const exists = (path: string) => ['src/a.test.ts', 'tests/a.test.ts', 'packages/x/tests/b.test.ts'].includes(path)

    expect(siblingTests('src/a.ts', exists)).toEqual(['src/a.test.ts', 'tests/a.test.ts'])
    expect(siblingTests('packages/x/src/b.ts', exists)).toEqual(['packages/x/tests/b.test.ts'])
    expect(siblingTests('src/c.ts', exists)).toEqual([])
  })
})

describe('narrow', () => {
  const step = (name: string, command = `bun run ${name}`) => ({ name, command, source: 'package.json' })

  test('lint takes the changed source files of a bare linter script', async () => {
    const dir = repo({ lint: 'keslint --cache' })

    expect(await narrow(step('lint'), dir, ['src/a.ts', 'README.md'])).toEqual({ command: 'bun run lint -- \'src/a.ts\'', note: '1 changed file' })
    expect(await narrow(step('lint'), dir, ['README.md'])).toEqual({ command: 'true', note: 'nothing changed to lint' })
  })

  test('lint stays in full when the script names its own paths', async () => {
    const dir = repo({ lint: 'eslint src' })

    expect((await narrow(step('lint'), dir, ['src/a.ts'])).note).toBe('in full, lint cannot be narrowed')
  })

  test('test takes the changed tests and those next to the changed sources', async () => {
    const dir = repo({ test: 'bun test --parallel' })

    expect(await narrow(step('test'), dir, ['src/a.ts'])).toEqual({ command: 'bun run test -- \'./tests/a.test.ts\'', note: '1 test file' })
    expect((await narrow(step('test'), dir, ['tests/a.test.ts', 'src/a.ts'])).note).toBe('1 test file')
  })

  test('test runs in full when no test sits next to the diff', async () => {
    const dir = repo({ test: '$npm_execpath test' })

    expect(await narrow(step('test'), dir, ['src/b.ts'])).toEqual({ command: 'bun run test', note: 'in full, no test sits next to the changed files' })
  })

  test('typecheck is never narrowed', async () => {
    const dir = repo({ typecheck: 'tsc' })

    expect((await narrow(step('typecheck'), dir, ['src/a.ts'])).note).toBe('in full, typecheck cannot be narrowed')
  })
})

describe('check --changed', () => {
  test('--list shows the narrowed commands', async () => {
    const dir = repo({ lint: 'keslint', test: 'bun test' })

    write(dir, 'src/a.ts', 'changed\n')

    const { out } = await capture(async () => check(['--changed', '--list', '--json'], dir))
    const steps = JSON.parse(out) as { name: string, command: string }[]

    expect(steps.map(each => each.command)).toEqual(['bun run lint -- \'src/a.ts\'', 'bun run test -- \'./tests/a.test.ts\''])
  })

  test('refuses outside a repository', async () => {
    const dir = temp('narrow-plain-')

    write(dir, 'package.json', JSON.stringify({ scripts: { lint: 'keslint' } }))

    const [run] = await Promise.allSettled([check(['--changed', '--list'], dir)])

    expect(run.status === 'rejected' ? String(run.reason) : '').toContain('--changed needs a git repository')
  })
})
