import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { duration, Exit, parse, readInput } from '../src'

const options = { lines: { type: 'string', short: 'n', description: 'lines' } } as const

describe('parse', () => {
  test('leaves a `--` to node:util unless asked to pass it through', () => {
    expect(parse(['-n', '5', '--', 'a'], 'u', options)).toMatchObject({ values: { lines: '5' }, positionals: ['a'], rest: undefined })
  })

  test('hands what follows `--` back untouched, options included', () => {
    expect(parse(['-n', '5', 'x', '--', 'ls', '-n', '--help'], 'u', options, { rest: true })).toMatchObject({ values: { lines: '5' }, positionals: ['x'], rest: ['ls', '-n', '--help'] })
    expect(parse(['-n', '5'], 'u', options, { rest: true })?.rest).toBeUndefined()
  })

  test('takes `--no-<flag>` as false only when asked to', () => {
    const flags = { emoji: { type: 'boolean', default: true, description: 'emoji' } } as const

    expect(parse(['--no-emoji'], 'u', flags, { allowNegative: true })?.values.emoji).toBe(false)
    expect(parse([], 'u', flags, { allowNegative: true })?.values.emoji).toBe(true)
    expect(() => parse(['--no-emoji'], 'u', flags)).toThrow(Exit)
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

describe('duration', () => {
  test('reads a unit, or the default unit on a bare number', () => {
    expect(duration('500ms', 't', 0)).toBe(500)
    expect(duration('1.5s', 't', 0)).toBe(1500)
    expect(duration('90', 't', 0)).toBe(90_000)
    expect(duration('15', 't', 0, 'm')).toBe(900_000)
    expect(duration('1h', 't', 0, 'm')).toBe(3_600_000)
    expect(duration(undefined, 't', 42)).toBe(42)
  })

  test('refuses anything else', () => {
    expect(() => duration('5 min', 'timeout', 0)).toThrow(new Exit('--timeout takes a duration such as 30s, 5m or 1h, not 5 min', 2))
    expect(() => duration('0', 'timeout', 0)).toThrow(Exit)
  })
})
