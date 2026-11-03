import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const DX = new URL('../src/dx-cli.ts', import.meta.url).pathname

describe('dx', () => {
  test('prints its version and its usage', () => {
    expect(Bun.spawnSync([process.execPath, DX, '--version'], { stdout: 'pipe' }).stdout.toString().trim()).toBe(version)
    expect(Bun.spawnSync([process.execPath, DX, '--help'], { stdout: 'pipe' }).stdout.toString()).toContain('dx [service] [action]')
  })
})
