import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname

function pkg(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('pkg', () => {
  test('prints its version and its help', () => {
    expect(pkg('--version').out.trim()).toBe(version)

    const help = pkg('--help')

    expect(help.code).toBe(0)
    expect(help.out).toContain('--min-age')
  })

  test('needs a package name', () => {
    const result = pkg()

    expect(result.code).toBe(2)
    expect(result.err).toContain('a package name is needed')
  })
})
