import type { Stack } from '../src/stack'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { followMasked, followOrNot, maskedLogs } from '../src/dx'
import { logsOf } from '../src/stack'

const SECRET = 'zq81vkw0pLm'
const original = process.cwd()
const folder = mkdtempSync(join(tmpdir(), 'dx-'))

beforeAll(() => {
  writeFileSync(join(folder, '.env'), `DB_PASSWORD=${SECRET}\n`)
  process.chdir(folder)
})

afterAll(() => {
  process.chdir(original)
  rmSync(folder, { recursive: true, force: true })
})

describe('maskedLogs', () => {
  test('runs the logs through this CLI, which masks them in-process, so ev is not needed', () => {
    expect(maskedLogs(['docker', 'logs'], ['bun', '/x/dc-cli.js'])).toEqual(['bun', '/x/dc-cli.js', '--masked', 'docker', 'logs'])
  })
})

describe('followMasked', () => {
  test('masks the known secrets of the folder in the followed output', async () => {
    const written: string[] = []
    const write = process.stdout.write.bind(process.stdout)

    process.stdout.write = (chunk: string) => {
      written.push(chunk)

      return true
    }

    try {
      expect(await followMasked(['echo', `login ${SECRET} failed`])).toBe(0)
    }
    finally {
      process.stdout.write = write
    }

    expect(written.join('')).toContain('login')
    expect(written.join('')).not.toContain(SECRET)
  })
})

describe('logsOf', () => {
  test('masks the known secrets of the folder', async () => {
    const stack: Stack = { dir: '.', run: [], list: { argv: ['sh', '-c', `echo "login ${SECRET} failed"`], cwd: folder, env: {} } }
    const text = await logsOf(stack, 'php')

    expect(text).toContain('login')
    expect(text).not.toContain(SECRET)
  })
})

describe('followOrNot', () => {
  test('follows on a terminal and prints once elsewhere, an explicit flag winning', () => {
    expect(followOrNot(undefined, { isTTY: true })).toBe(true)
    expect(followOrNot(undefined, {})).toBe(false)
    expect(followOrNot(true, {})).toBe(true)
    expect(followOrNot(false, { isTTY: true })).toBe(false)
  })
})
