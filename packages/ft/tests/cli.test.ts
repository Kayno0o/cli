import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname

function ft(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('ft issue flags', () => {
  test('--copy goes with --body, --open does not', () => {
    expect(ft('issue', '1', '--copy')).toMatchObject({ code: 2, err: expect.stringContaining('--copy goes with --body') })
    expect(ft('issue', '1', '--body', '--open')).toMatchObject({ code: 2, err: expect.stringContaining('--open does not go with --body') })
  })
})

describe('ft', () => {
  test('lists its commands, and prints its version', () => {
    const help = ft('--help')

    expect(help.code).toBe(0)
    expect(help.out).toContain('board')
    expect(ft('--version').out.trim()).toBe(version)
  })

  test('groups its commands into sections', () => {
    const lines = ft('--help').out.split('\n')
    const heading = (name: string) => lines.findIndex(line => line === `${name}:`)
    const row = (name: string) => lines.findIndex(line => line.trimStart().startsWith(`${name} `))

    expect(heading('CI and release')).toBeLessThan(row('ci'))
    expect(row('ci')).toBeLessThan(heading('Issues and claims'))
    expect(row('board')).toBeLessThan(heading('Repo'))
    expect(row('remote')).toBeGreaterThan(heading('Repo'))
  })

  test('prints a command\'s help', () => {
    const help = ft('tick', '--help')

    expect(help.code).toBe(0)
    expect(help.out).toContain('--undo')
  })

  test('runs show and view as issue, and names the command a typo meant', () => {
    expect(ft('show', '--help').out).toStartWith('Usage: ft issue [<n>...]')
    expect(ft('view', '--help').out).toStartWith('Usage: ft issue [<n>...]')

    const typo = ft('tik', '12', '1')

    expect(typo.code).toBe(2)
    expect(typo.err.trim()).toBe('error: ft: no command tik\n  hint: did you mean tick?')
    expect(ft('nope').err).toContain('hint: run ft --help for its commands')
  })

  test('refuses a comment given twice or from a missing file before writing anything', () => {
    const twice = ft('tick', '12', '1', '-m', 'done', '-F', 'note.md')

    expect(twice.code).toBe(2)
    expect(twice.err.trim()).toBe('error: ft tick: give the comment once, as text or with -F')
    expect(ft('comment', '12', '-F', '/no/such/note.md').err.trim()).toBe('error: ft comment: no file /no/such/note.md')
  })

  test('refuses an unknown board state or a broken query before reading the board', () => {
    expect(ft('board', '--state', 'stale').err.trim()).toBe('error: ft board: --state takes one of available, taken, away, not stale\n  hint: run ft board --help for its options')
    expect(ft('board', '--query', '(').err).toStartWith('error: ft board: --query:')
    expect(ft('issues', '--query', '(').err).toStartWith('error: ft issues: --query:')
  })

  test('exits 2 on an unknown command, an unknown flag or a missing argument', () => {
    expect(ft('nope').code).toBe(2)

    const flag = ft('runs', '--zzzz')

    expect(flag.code).toBe(2)
    expect(flag.err).toBe('error: ft runs: unknown option \'--zzzz\'\n  hint: run ft runs --help for its options\n')

    const missing = ft('tick', '12')

    expect(missing.code).toBe(2)
    expect(missing.err).toContain('name the boxes to tick')
  })
})
