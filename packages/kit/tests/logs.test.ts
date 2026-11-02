import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createLog, privateLogDirectory, sweepLogs } from '../src'

const runtime = () => mkdtempSync(join(tmpdir(), 'kit-logs-'))

describe('privateLogDirectory', () => {
  test('creates a folder only the user can use under XDG_RUNTIME_DIR', async () => {
    const base = runtime()
    const dir = await privateLogDirectory('check/repo', { XDG_RUNTIME_DIR: base })

    expect(dir).toBe(join(base, 'agent-tools', 'check/repo'))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(await privateLogDirectory('check/repo', { XDG_RUNTIME_DIR: base })).toBe(dir)
  })

  test('does not trust an existing folder others can read, nor a link', async () => {
    const base = runtime()
    const open = join(base, 'agent-tools', 'open')

    mkdirSync(open, { recursive: true, mode: 0o755 })
    chmodSync(open, 0o755)
    expect(await privateLogDirectory('open', { XDG_RUNTIME_DIR: base })).not.toBe(open)

    symlinkSync(tmpdir(), join(base, 'agent-tools', 'linked'))

    const used = await privateLogDirectory('linked', { XDG_RUNTIME_DIR: base })

    expect(used).not.toBe(join(base, 'agent-tools', 'linked'))
    expect(statSync(used).mode & 0o777).toBe(0o700)
  })
})

describe('sweepLogs', () => {
  test('removes old files and the old folders they leave, keeps the recent ones', async () => {
    const dir = runtime()
    const old = new Date(Date.now() - 5 * 86_400_000)

    mkdirSync(join(dir, 'run'))
    writeFileSync(join(dir, 'run', 'a.log'), 'x')
    writeFileSync(join(dir, 'recent.log'), 'x')
    utimesSync(join(dir, 'run', 'a.log'), old, old)
    utimesSync(join(dir, 'run'), old, old)
    await sweepLogs(dir)

    expect(existsSync(join(dir, 'run'))).toBe(false)
    expect(existsSync(join(dir, 'recent.log'))).toBe(true)
  })
})

describe('createLog', () => {
  test('makes a file of mode 0600 and refuses one that exists', () => {
    const path = join(runtime(), 'x.log')

    createLog(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(() => createLog(path)).toThrow()
  })
})
