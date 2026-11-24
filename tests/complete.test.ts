import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { bins } from './bins'

// What the fish completions call, so a bin that stops answering fails here rather than completes nothing.
describe('every bin answers __complete', () => {
  for (const { bin, source } of bins) {
    test(bin, () => {
      const result = Bun.spawnSync([process.execPath, source, '__complete', ''], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

      expect({ code: result.exitCode, err: result.stderr.toString() }).toEqual({ code: 0, err: '' })
    })
  }
})

describe('dynamic candidates', () => {
  const sourceOf = (name: string) => bins.find(each => each.bin === name)!.source

  test('gb, gm and gp -b offer branches of the repository', () => {
    for (const [bin, args] of [['gb', ['']], ['gm', ['']], ['gp', ['-b', '']]] as const) {
      const result = Bun.spawnSync([process.execPath, sourceOf(bin), '__complete', ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('main\t')
    }
  })

  test('ev get offers key names from .env without leaking values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-complete-ev-'))

    try {
      writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://secret@localhost/db\nAPI_TOKEN=super_secret_val\n')

      const result = Bun.spawnSync([process.execPath, sourceOf('ev'), '__complete', 'get', ''], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
      const out = result.stdout.toString()

      expect(result.exitCode).toBe(0)
      expect(out).toContain('API_TOKEN')
      expect(out).toContain('DATABASE_URL')
      expect(out).not.toContain('super_secret_val')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('dc offers subcommands and actions and guard hook offers hook events', () => {
    const dc = Bun.spawnSync([process.execPath, sourceOf('dc'), '__complete', ''], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
    const dcAction = Bun.spawnSync([process.execPath, sourceOf('dc'), '__complete', 'php', ''], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
    const guard = Bun.spawnSync([process.execPath, sourceOf('guard'), '__complete', 'hook', ''], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

    expect(dc.stdout.toString()).toContain('health')
    expect(dc.stdout.toString()).toContain('logs')
    expect(dc.stdout.toString()).toContain('port')
    expect(dcAction.stdout.toString()).toContain('logs')
    expect(dcAction.stdout.toString()).toContain('restart')
    expect(guard.stdout.toString()).toContain('pre-tool-use')
  })
})
