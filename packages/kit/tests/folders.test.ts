import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { cacheFolder, ignoredFolders, SKIPPED_FOLDERS } from '../src/folders'
import { tempDirs } from '../src/test'
import { configuredNumber, readUserConfig } from '../src/user-config'

const temp = tempDirs()

function home(config?: string) {
  const dir = temp('folders-home-')

  if (config !== undefined) {
    mkdirSync(join(dir, '.config', 'kaynooo-cli'), { recursive: true })
    writeFileSync(join(dir, '.config', 'kaynooo-cli', 'config.json'), config)
  }

  return dir
}

describe('cacheFolder', () => {
  test('takes an absolute XDG_CACHE_HOME, and ~/.cache for an empty or relative one', () => {
    expect(cacheFolder({ home: '/h', env: { XDG_CACHE_HOME: '/c' } })).toBe('/c')

    for (const value of [undefined, '', 'rel/cache'])
      expect(cacheFolder({ home: '/h', env: { XDG_CACHE_HOME: value } })).toBe('/h/.cache')
  })
})

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

describe('configuredNumber', () => {
  function homeWith(bin: string, content: string) {
    const dir = temp('folders-home-')

    mkdirSync(join(dir, '.config', 'kaynooo-cli'), { recursive: true })
    writeFileSync(join(dir, '.config', 'kaynooo-cli', `${bin}.json`), content)

    return dir
  }

  test('is the number the bin file sets, comments allowed', () => {
    expect(configuredNumber('ft', 'concurrency', 8, { home: homeWith('ft', '{ // faster\n "concurrency": 2 }') })).toBe(2)
  })

  test('is the fallback for a missing file, a missing key and a value that is no positive whole number', () => {
    expect(configuredNumber('ft', 'concurrency', 8, { home: home() })).toBe(8)
    expect(configuredNumber('ft', 'concurrency', 8, { home: homeWith('ft', '{}') })).toBe(8)

    for (const value of ['0', '-1', '1.5', '"3"', 'null'])
      expect(configuredNumber('ft', 'concurrency', 8, { home: homeWith('ft', `{ "concurrency": ${value} }`) })).toBe(8)
  })

  test('reads the older file while the new one is missing', () => {
    const dir = temp('folders-home-')

    mkdirSync(join(dir, '.config', 'ft'), { recursive: true })
    writeFileSync(join(dir, '.config', 'ft', 'config.json'), '{ "concurrency": 5 }')

    expect(configuredNumber('ft', 'concurrency', 8, { home: dir }, [['ft', 'config.json']])).toBe(5)
  })
})
