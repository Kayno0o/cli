import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { tempDirs } from '../src/test'
import { configBase, configuredForge, getConfigKey, mainConfigPath, parseConfigValue, readUserConfig, setConfigKey, unsetConfigKey, updateMainConfig, userConfigPath, userConfigReadPath } from '../src/user-config'

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

describe('configuredForge', () => {
  function withForge(forge: unknown): string {
    const home = temp('kit-forge-')

    mkdirSync(join(home, '.config', 'kaynooo-cli'), { recursive: true })
    writeFileSync(join(home, '.config', 'kaynooo-cli', 'config.json'), JSON.stringify({ forge }))

    return home
  }

  it('reads a host as served over https, and a URL as given', () => {
    expect(configuredForge({ home: withForge('git.example.org') })).toEqual({ host: 'git.example.org', url: 'https://git.example.org' })
    expect(configuredForge({ home: withForge('http://forge.lan:3000/') })).toEqual({ host: 'forge.lan:3000', url: 'http://forge.lan:3000' })
  })

  it('is undefined when the key is unset, empty or no string', () => {
    expect(configuredForge({ home: temp('kit-forge-') })).toBeUndefined()
    expect(configuredForge({ home: withForge('') })).toBeUndefined()
    expect(configuredForge({ home: withForge(3) })).toBeUndefined()
  })
})

describe('unified config.jsonc and dotted keys', () => {
  it('merges a per-bin section from config.jsonc over a legacy per-bin file', () => {
    const home = temp('kit-unified-')
    const dir = join(home, '.config', 'kaynooo-cli')

    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'out.json'), JSON.stringify({ lines: 100, width: 200 }))
    writeFileSync(join(dir, 'config.jsonc'), '// unified config\n{ "out": { "lines": 250 } }\n')

    expect(mainConfigPath({ home })).toBe(join(dir, 'config.jsonc'))
    expect(readUserConfig('out', { home })).toEqual({ lines: 250, width: 200 })
  })

  it('parses, gets, sets, unsets and persists dotted keys safely', () => {
    const home = temp('kit-keys-')

    expect(parseConfigValue('true')).toBe(true)
    expect(parseConfigValue('42')).toBe(42)
    expect(parseConfigValue('["a","b"]')).toEqual(['a', 'b'])
    expect(parseConfigValue('~/Workspace')).toBe('~/Workspace')

    expect(updateMainConfig((cfg) => {
      expect(setConfigKey(cfg, 'out.lines', 220)).toBe(true)
      expect(setConfigKey(cfg, '__proto__.polluted', 1)).toBe(false)
    }, { home })).toBe(true)

    expect(getConfigKey(readUserConfig('config', { home }), 'out.lines')).toBe(220)
    expect(updateMainConfig((cfg) => {
      expect(unsetConfigKey(cfg, 'out.lines')).toBe(true)
    }, { home })).toBe(true)
    expect(getConfigKey(readUserConfig('config', { home }), 'out.lines')).toBeUndefined()
  })
})
