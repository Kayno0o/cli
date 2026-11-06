import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { ignoredFolders, SKIPPED_FOLDERS } from '../src/folders'
import { tempDirs } from '../src/test'
import { readUserConfig } from '../src/user-config'

const temp = tempDirs()

function home(config?: string) {
  const dir = temp('folders-home-')

  if (config !== undefined) {
    mkdirSync(join(dir, '.config', 'kaynooo-cli'), { recursive: true })
    writeFileSync(join(dir, '.config', 'kaynooo-cli', 'config.json'), config)
  }

  return dir
}

describe('ignoredFolders', () => {
  test('is the built-in set with nothing configured', () => {
    expect([...ignoredFolders([], { home: home() })].sort()).toEqual([...SKIPPED_FOLDERS].sort())
  })

  test('adds the ignore key of config.json and the names a bin gives', () => {
    const found = ignoredFolders(['var'], { home: home(JSON.stringify({ ignore: ['.venv', 'out'] })) })

    expect([...found].filter(name => !SKIPPED_FOLDERS.has(name)).sort()).toEqual(['.venv', 'out', 'var'])
    expect(found.has('node_modules')).toBe(true)
  })

  test('skips entries that are no string, a key that is no array and a file that does not parse', () => {
    expect(ignoredFolders([], { home: home(JSON.stringify({ ignore: ['ok', 3, ''] })) }).size).toBe(SKIPPED_FOLDERS.size + 1)
    expect(ignoredFolders([], { home: home(JSON.stringify({ ignore: 'out' })) }).size).toBe(SKIPPED_FOLDERS.size)
    expect(ignoredFolders([], { home: home('{ nope') }).size).toBe(SKIPPED_FOLDERS.size)
  })
})

describe('readUserConfig', () => {
  test('is empty for a missing file, an array and a file that does not parse', () => {
    expect(readUserConfig('config', { home: home() })).toEqual({})
    expect(readUserConfig('config', { home: home('[1]') })).toEqual({})
    expect(readUserConfig('config', { home: home('{ nope') })).toEqual({})
  })

  test('returns the keys of the bin file', () => {
    expect(readUserConfig('config', { home: home('{"ignore":["a"]}') })).toEqual({ ignore: ['a'] })
  })
})
