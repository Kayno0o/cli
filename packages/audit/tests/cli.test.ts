import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { version } from '../package.json'

const AUDIT = new URL('../src/audit.ts', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'audit-cli-'))

function audit(...args: string[]) {
  const ran = Bun.spawnSync([process.execPath, AUDIT, ...args], { stdout: 'pipe', stderr: 'pipe' })

  return { code: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() }
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('audit', () => {
  test('prints its version and its usage', () => {
    expect(audit('--version').out.trim()).toBe(version)
    expect(audit('--help').out).toContain('audit [options] [root]')
  })

  test('a root that is no folder is a usage error, and a folder with no bun.lock exits 1 saying so', () => {
    expect(audit(join(dir, 'nowhere')).code).toBe(2)

    const empty = audit(dir)

    expect(empty.code).toBe(1)
    expect(empty.err).toContain('no bun.lock')
  })

  test('an unknown level is a usage error', () => {
    expect(audit('--level', 'severe', dir).code).toBe(2)
  })
})
