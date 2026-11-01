import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname

function stack(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

describe('stack', () => {
  test('prints its version and lists its commands', () => {
    expect(stack('--version').out.trim()).toBe(version)
    expect(stack('--help').out).toContain('audit')
  })

  test('port prints the same number as the old script', () => {
    expect(stack('port', 'hello').out).toBe('9377\n')
    expect(JSON.parse(stack('port', 'hello', '--json').out)).toEqual({ name: 'hello', port: 9377, listening: false })
  })
})
