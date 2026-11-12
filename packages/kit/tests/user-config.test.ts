import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { tempDirs } from '../src/test'
import { configBase, userConfigPath, userConfigReadPath } from '../src/user-config'

const temp = tempDirs()

function put(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '{}')
}

describe('userConfigPath', () => {
  it('sits under <home>/.config/kaynooo-cli, one file per bin', () => {
    expect(userConfigPath('ft', { home: '/h' })).toBe('/h/.config/kaynooo-cli/ft.json')
  })

  it('follows an explicit XDG base, and ignores the environment when a home is given', () => {
    expect(userConfigPath('db', { xdg: '/x' })).toBe('/x/kaynooo-cli/db.json')
    expect(configBase({ home: '/h' })).toBe('/h/.config')
    expect(configBase({ home: '/h', xdg: 'rel' })).toBe('/h/.config')
  })
})

describe('userConfigReadPath', () => {
  it('reads the new file when it exists, even beside a legacy one', () => {
    const home = temp('kit-uc-')

    put(join(home, '.config', 'kaynooo-cli', 'ft.json'))
    put(join(home, '.config', 'ft', 'config.json'))

    expect(userConfigReadPath('ft', [['ft', 'config.json']], { home })).toBe(join(home, '.config', 'kaynooo-cli', 'ft.json'))
  })

  it('falls back to the legacy file while the new one is missing', () => {
    const home = temp('kit-uc-')

    put(join(home, '.config', 'ft', 'config.json'))

    expect(userConfigReadPath('ft', [['ft', 'config.json']], { home })).toBe(join(home, '.config', 'ft', 'config.json'))
  })

  it('names the new path when nothing exists, so a write lands there', () => {
    const xdg = temp('kit-uc-')

    expect(userConfigReadPath('pkg', [['pkg', 'config.json']], { xdg })).toBe(join(xdg, 'kaynooo-cli', 'pkg.json'))
  })
})
