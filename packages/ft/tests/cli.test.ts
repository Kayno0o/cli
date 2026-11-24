import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname

function fg(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('fg issue flags', () => {
  test('--copy goes with --body, --open does not', () => {
    expect(fg('issue', '1', '--copy')).toMatchObject({ code: 2, err: expect.stringContaining('--copy goes with --body') })
    expect(fg('issue', '1', '--body', '--open')).toMatchObject({ code: 2, err: expect.stringContaining('--open does not go with --body') })
  })
})

describe('fg', () => {
  test('lists its commands, and prints its version', () => {
    const help = fg('--help')

    expect(help.code).toBe(0)
    expect(help.out).toContain('board')
    expect(help.out).toContain('pr')
    expect(help.out).toContain('retry')
    expect(help.out).toContain('play')
    expect(fg('--version').out.trim()).toBe(version)
  })

  test('groups its commands into sections', () => {
    const lines = fg('--help').out.split('\n')
    const heading = (name: string) => lines.findIndex(line => line === `${name}:`)
    const row = (name: string) => lines.findIndex(line => line.trimStart().startsWith(`${name} `))

    expect(heading('CI and release')).toBeLessThan(row('ci'))
    expect(row('ci')).toBeLessThan(heading('Pull requests'))
    expect(heading('Pull requests')).toBeLessThan(row('pr'))
    expect(row('pr')).toBeLessThan(heading('Issues and claims'))
    expect(row('board')).toBeLessThan(heading('Repo'))
    expect(row('milestones')).toBeGreaterThan(heading('Repo'))
  })

  test('prints a command\'s help', () => {
    const help = fg('tick', '--help')

    expect(help.code).toBe(0)
    expect(help.out).toContain('--undo')
  })

  test('runs show and view as issue, mr as pr, and names the command a typo meant', () => {
    expect(fg('show', '--help').out).toStartWith('Usage: ft issue [<n>...]')
    expect(fg('view', '--help').out).toStartWith('Usage: ft issue [<n>...]')
    expect(fg('mr', '--help').out).toContain('fg pr')

    const typo = fg('tik', '12', '1')

    expect(typo.code).toBe(2)
    expect(typo.err.trim()).toBe('error: fg: no command tik\n  hint: did you mean tick?')
    expect(fg('nope').err).toContain('hint: run fg --help for its commands')
  })

  test('refuses a comment given twice or from a missing file before writing anything', () => {
    const twice = fg('tick', '12', '1', '-m', 'done', '-F', 'note.md')

    expect(twice.code).toBe(2)
    expect(twice.err.trim()).toBe('error: fg tick: give the comment once, as text or with -F')
    expect(fg('comment', '12', '-F', '/no/such/note.md').err.trim()).toBe('error: fg comment: no file /no/such/note.md')
  })

  test('refuses an unknown board state or a broken query before reading the board', () => {
    expect(fg('board', '--state', 'stale').err.trim()).toBe('error: fg board: --state takes one of available, taken, away, not stale\n  hint: run fg board --help for its options')
    expect(fg('board', '--query', '(').err).toStartWith('error: fg board: --query:')
    expect(fg('issues', '--query', '(').err).toStartWith('error: fg issues: --query:')
  })

  test('exits 2 on an unknown command, an unknown flag or a missing argument', () => {
    expect(fg('nope').code).toBe(2)

    const flag = fg('runs', '--zzzz')

    expect(flag.code).toBe(2)
    expect(flag.err).toBe('error: fg runs: unknown option \'--zzzz\'\n  hint: run fg runs --help for its options\n')

    const missing = fg('tick', '12')

    expect(missing.code).toBe(2)
    expect(missing.err).toContain('name the boxes to tick')
  })
})
