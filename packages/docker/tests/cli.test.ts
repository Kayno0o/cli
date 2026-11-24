import { describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const DC = new URL('../src/dc-cli.ts', import.meta.url).pathname

describe('dc unified cli', () => {
  test('prints its version, help, and subcommand help', () => {
    expect(Bun.spawnSync([process.execPath, DC, '--version'], { stdout: 'pipe' }).stdout.toString().trim()).toBe(version)

    const help = Bun.spawnSync([process.execPath, DC, '--help'], { stdout: 'pipe' }).stdout.toString()

    expect(help).toContain('dc health')
    expect(help).toContain('dc logs')
    expect(help).toContain('dc shell')
    expect(help).toContain('dc exec')
    expect(help).toContain('dc port')
    expect(help).toContain('dc ports')

    expect(Bun.spawnSync([process.execPath, DC, 'health', '--help'], { stdout: 'pipe' }).stdout.toString()).toContain('dlog [service...]')
    expect(Bun.spawnSync([process.execPath, DC, 'logs', '--help'], { stdout: 'pipe' }).stdout.toString()).toContain('dc logs [service...]')
    expect(Bun.spawnSync([process.execPath, DC, 'port', '--help'], { stdout: 'pipe' }).stdout.toString()).toContain('dc port <name>')
    expect(Bun.spawnSync([process.execPath, DC, 'port', 'hello'], { stdout: 'pipe' }).stdout.toString().trim()).toBe('13483')
  })
})
