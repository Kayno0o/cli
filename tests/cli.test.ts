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
