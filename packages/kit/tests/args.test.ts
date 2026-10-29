import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { Exit, parse, readInput } from '../src'

const options = { lines: { type: 'string', short: 'n', description: 'lines' } } as const

describe('parse', () => {
  test('leaves a `--` to node:util unless asked to pass it through', () => {
    expect(parse(['-n', '5', '--', 'a'], 'u', options)).toMatchObject({ values: { lines: '5' }, positionals: ['a'], rest: undefined })
  })

  test('hands what follows `--` back untouched, options included', () => {
    expect(parse(['-n', '5', 'x', '--', 'ls', '-n', '--help'], 'u', options, { rest: true })).toMatchObject({ values: { lines: '5' }, positionals: ['x'], rest: ['ls', '-n', '--help'] })
    expect(parse(['-n', '5'], 'u', options, { rest: true })?.rest).toBeUndefined()
  })
})

describe('readInput', () => {
  test('reads a file', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kit-')), 'in.txt')

    writeFileSync(path, 'hello\n')
    expect(await readInput(path)).toBe('hello\n')
  })

  test('refuses a missing file', async () => {
    expect(readInput('/no/such/file')).rejects.toThrow(new Exit('no file /no/such/file', 2))
  })
})
