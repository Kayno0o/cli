import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'bun:test'

const CLI = new URL('../src/proof.ts', import.meta.url).pathname

let repo = ''

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })

  return result.stdout.toString().trim()
}

function proof(args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

function file(name: string, text: string): void {
  mkdirSync(join(repo, name, '..'), { recursive: true })
  writeFileSync(join(repo, name), text)
}

// A test that prints what it checked, so the output of the failing side can be told.
function check(word: string): string[] {
  return ['--', `grep -q ${word} a.txt || { echo "missing ${word}"; exit 1; }`]
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'proof-test-')))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  file('a.txt', 'second\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
})

describe('proof', () => {
  test('fails before and passes now: exit 0, with the output of the run before', () => {
    file('a.txt', 'fixed\n')
    const result = proof(check('fixed'))

    expect(result.code).toBe(0)
    expect(result.out).toBe(`fails at ${git('rev-parse', '--short=7', 'HEAD')}, passes now\n\nmissing fixed\n`)
  })

  test('passes before too: exit 1', () => {
    const result = proof(check('second'))

    expect(result.code).toBe(1)
    expect(result.out).toBe(`passes at ${git('rev-parse', '--short=7', 'HEAD')} too: it does not fail without the change\n`)
  })

  test('fails before and fails now: exit 1, with the output of the run now', () => {
    const result = proof(check('nothing'))

    expect(result.code).toBe(1)
    expect(result.out).toBe(`fails at ${git('rev-parse', '--short=7', 'HEAD')} and fails now too\n\nmissing nothing\n`)
  })

  test('passes before and fails now: exit 1, with the output of the run now', () => {
    file('a.txt', 'other\n')
    const result = proof(check('second'))

    expect(result.code).toBe(1)
    expect(result.out).toBe(`passes at ${git('rev-parse', '--short=7', 'HEAD')}, fails now\n\nmissing second\n`)
  })

  test('--ref picks the commit run before and --keep carries a new file there', () => {
    file('a.txt', 'third\n')
    git('commit', '-q', '-am', 'second')
    file('new.test.txt', 'new\n')
    const first = git('rev-parse', '--short=7', 'HEAD~1')
    const result = proof(['--ref', 'HEAD~1', '--keep', 'new.test.txt', '--', 'grep -q third a.txt && grep -q new new.test.txt || { echo "red"; exit 1; }'])

    expect(result.code).toBe(0)
    expect(result.out).toBe(`fails at ${first}, passes now\n\nred\n`)
  })

  test('--json prints the outcome and both runs', () => {
    file('a.txt', 'fixed\n')
    const result = proof(['--json', ...check('fixed')])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.out)).toEqual({
      outcome: 'proved',
      proved: true,
      ref: 'HEAD',
      sha: git('rev-parse', 'HEAD'),
      before: { code: 1, output: 'missing fixed\n' },
      now: { code: 0, output: '' },
    })
  })

  test('exits 2 on no command, an unknown ref or a command that cannot start', () => {
    expect(proof([]).code).toBe(2)
    expect(proof(['--ref', 'nope', '--', 'true']).code).toBe(2)
    expect(proof(['--', 'no-such-binary-here']).code).toBe(2)
    expect(git('worktree', 'list').split('\n')).toHaveLength(1)
  })
})
