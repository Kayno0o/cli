import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname

function ft(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('ft', () => {
  test('lists its commands, and prints its version', () => {
    const help = ft('--help')

    expect(help.code).toBe(0)
    expect(help.out).toContain('board')
    expect(ft('--version').out.trim()).toBe(version)
  })

  test('prints a command\'s help', () => {
    const help = ft('tick', '--help')

    expect(help.code).toBe(0)
    expect(help.out).toContain('--undo')
  })

  test('runs show and view as issue, and names the command a typo meant', () => {
    expect(ft('show', '--help').out).toStartWith('ft issue <n>')
    expect(ft('view', '--help').out).toStartWith('ft issue <n>')

    const typo = ft('tik', '12', '1')

    expect(typo.code).toBe(2)
    expect(typo.err.trim()).toBe('ft: no command tik, did you mean tick?')
    expect(ft('nope').err).toContain('usage: ft <command>')
  })

  test('refuses a comment given twice or from a missing file before writing anything', () => {
    const twice = ft('tick', '12', '1', '-m', 'done', '-F', 'note.md')

    expect(twice.code).toBe(2)
    expect(twice.err.trim()).toBe('ft tick: give the comment once, as text or with -F')
    expect(ft('comment', '12', '-F', '/no/such/note.md').err.trim()).toBe('ft comment: no file /no/such/note.md')
  })

  test('refuses an unknown board state or a broken query before reading the board', () => {
    expect(ft('board', '--state', 'stale').err.trim()).toBe('ft board: --state takes available, taken or away, not stale')
    expect(ft('board', '-q', '(').err).toStartWith('ft board: --query:')
  })

  test('exits 2 on an unknown command, an unknown flag or a missing argument', () => {
    expect(ft('nope').code).toBe(2)

    const flag = ft('runs', '--nope')

    expect(flag.code).toBe(2)
    expect(flag.err).toStartWith('ft runs: Unknown option \'--nope\'')

    const missing = ft('tick', '12')

    expect(missing.code).toBe(2)
    expect(missing.err).toContain('name the boxes to tick')
  })
})
