import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Exit } from '@kaynooo/cli-kit'
import { describe, expect, spyOn, test } from 'bun:test'
import { reachable } from '../src/run'
import { loadSettings, settingsPath } from '../src/settings'

const root = mkdtempSync(join(tmpdir(), 'db-tools-hosts-'))

function homeWith(config: string | undefined): string {
  const home = mkdtempSync(join(root, 'home-'))

  if (config !== undefined) {
    mkdirSync(join(home, '.config', 'db'), { recursive: true })
    writeFileSync(settingsPath(home), config)
  }

  return home
}

async function refusal(value: string, home: string): Promise<Exit | undefined> {
  try {
    await reachable(value, home)
  }
  catch (error) {
    if (error instanceof Exit)
      return error
  }

  return undefined
}

describe('reachable', () => {
  const home = homeWith(undefined)

  test.each([
    'postgres://u:pw@localhost:5432/app',
    'postgres://u:pw@127.0.0.1/app',
    'postgres://u:pw@[::1]:5432/app',
    'postgres://u:pw@LOCALHOST/app',
    'postgres:///app?host=/var/run/postgresql',
  ])('lets %p through without a config', async (value) => {
    expect((await reachable(value, home)).href).toBe(new URL(value).href)
  })

  test.each([
    ['postgres://u:secret-pw@db.example.com:5432/app', 'db.example.com'],
    ['postgres://u:secret-pw@10.1.2.3/app', '10.1.2.3'],
    ['postgres://u:secret-pw@127.0.0.1,db.example.com/app', '127.0.0.1,db.example.com'],
    ['postgres:///app?host=db.example.com', 'db.example.com'],
  ])('refuses %p, naming the host and the config but never the password', async (value, host) => {
    const error = await refusal(value, home)

    expect(error?.code).toBe(2)
    expect(error?.message).toContain(host)
    expect(error?.message).toContain(settingsPath(home))
    expect(error?.message).not.toContain('secret-pw')
  })

  test('allows a listed host, case aside, and only that one', async () => {
    const listed = homeWith(JSON.stringify({ allowedHosts: ['DB.example.com', '10.1.2.3'] }))

    expect((await reachable('postgres://u:pw@db.example.com/app', listed)).hostname).toBe('db.example.com')
    expect((await reachable('postgres://u:pw@10.1.2.3/app', listed)).hostname).toBe('10.1.2.3')
    expect((await refusal('postgres://u:pw@other.example.com/app', listed))?.code).toBe(2)
  })

  test('an empty allowlist allows only local hosts', async () => {
    expect((await refusal('postgres://u:pw@db.example.com/app', homeWith('{"allowedHosts":[]}')))?.code).toBe(2)
  })
})

describe('loadSettings', () => {
  test('is empty when the file is missing or lists nothing usable', async () => {
    expect(await loadSettings(homeWith(undefined))).toEqual({})
    expect(await loadSettings(homeWith('[1]'))).toEqual({})
    expect(await loadSettings(homeWith('{"allowedHosts":"db.example.com"}'))).toEqual({})
    expect(await loadSettings(homeWith('{"allowedHosts":[1,"",null]}'))).toEqual({})
  })

  test('keeps the listed hosts', async () => {
    expect(await loadSettings(homeWith('{"allowedHosts":["a.example.com",3]}'))).toEqual({ allowedHosts: ['a.example.com'] })
  })

  test('warns about a file that is not JSON and allows nothing', async () => {
    const warning = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const home = homeWith('{ nope')

      expect(await loadSettings(home)).toEqual({})
      expect(warning).toHaveBeenCalledTimes(1)
      expect(String(warning.mock.calls[0]?.[0])).toContain(settingsPath(home))
    }
    finally {
      warning.mockRestore()
    }
  })
})
