import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname

function gl(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('gl', () => {
  test('lists its commands, prints its version and a command\'s help', () => {
    expect(gl('--help').out).toContain('logs')
    expect(gl('--version').out.trim()).toBe(version)
    expect(gl('ci', '--help').out).toStartWith('gl ci [ref]')
  })

  test('asks for a pipeline id before calling GitLab', () => {
    const missing = gl('logs')

    expect(missing.code).toBe(2)
    expect(missing.err).toContain('a pipeline id is needed')
  })
})
