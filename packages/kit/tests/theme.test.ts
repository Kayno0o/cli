import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createColors } from '@kaynooo/utils/tools/colors'
import { describe, expect, it } from 'bun:test'
import { tempDirs } from '../src/test'
import { isColorSpec, loadTheme, tinted } from '../src/theme'

const temp = tempDirs()

// A home with an optional global theme and a repository with an optional project theme, returning where to load from.
function world(global?: object | string, project?: object | string) {
  const home = temp('theme-home-')
  const repo = temp('theme-repo-')

  mkdirSync(join(repo, '.git'))

  if (global !== undefined) {
    mkdirSync(join(home, '.config', 'kaynooo-cli'), { recursive: true })
    writeFileSync(join(home, '.config', 'kaynooo-cli', 'theme.json'), typeof global === 'string' ? global : JSON.stringify(global))
  }

  if (project !== undefined) {
    mkdirSync(join(repo, '.kaynooo'))
    writeFileSync(join(repo, '.kaynooo', 'theme.json'), typeof project === 'string' ? project : JSON.stringify(project))
  }

  const warnings: string[] = []

  return { home, from: repo, env: {}, warn: (message: string) => void warnings.push(message), warnings }
}

describe('loadTheme', () => {
  it('is the default theme with no file', () => {
    const { theme, sources, preset } = loadTheme(world())

    expect(theme.colors.accent).toBe('cyan')
    expect(theme.glyphs.bar).toBe('━')
    expect(sources).toEqual([])
    expect(preset).toBe('default')
  })

  it('lays the project file over the global one key by key', () => {
    const where = world({ colors: { accent: 'magenta', id: '#ff8800' }, glyphs: { ok: '✔' } }, { colors: { accent: 'green' } })
    const { theme, sources } = loadTheme(where)

    expect(theme.colors.accent).toBe('green')
    expect(theme.colors.id).toBe('#ff8800')
    expect(theme.glyphs.ok).toBe('✔')
    expect(sources).toHaveLength(2)
    expect(where.warnings).toEqual([])
  })

  it('applies a preset, KIT_THEME winning over the files and the files over the default', () => {
    expect(loadTheme(world({ preset: 'ascii' })).theme.glyphs.bar).toBe('#')
    expect(loadTheme(world({ preset: 'ascii' }, { preset: 'mono' })).theme.colors.accent).toBe('bold')
    const chosen = loadTheme({ ...world({ preset: 'ascii', colors: { id: 'red' } }), env: { KIT_THEME: 'mono' } })

    expect(chosen.theme.glyphs.bar).toBe('━')
    expect(chosen.theme.colors.id).toBe('bold')
    expect(chosen.sources).toEqual([])
  })

  it('names the bins that choose their own colour', () => {
    expect(loadTheme(world({ bins: { ft: 'magenta' } })).theme.bins).toEqual({ ft: 'magenta' })
  })

  it('tells about a bad colour, glyph, key or preset and keeps the rest', () => {
    const where = world({ preset: 'neon', colors: { accent: 'chartreuse', nope: 'red', id: 'red' }, glyphs: { ok: '✓✓', bar: '=', warn: '\x1B]0;pwned\x07x', note: '\x1B[2J' } })
    const { theme } = loadTheme(where)

    expect(theme.colors.accent).toBe('cyan')
    expect(theme.colors.id).toBe('red')
    expect(theme.glyphs.ok).toBe('✓')
    expect(theme.glyphs.bar).toBe('=')
    expect(theme.glyphs.warn).toBe('▲')
    expect(theme.glyphs.note).toBe('›')
    expect(where.warnings).toHaveLength(6)
  })

  it('falls back to the default on a file that does not parse', () => {
    const where = world('{ nope', undefined)

    expect(loadTheme(where).theme.colors.accent).toBe('cyan')
    expect(where.warnings[0]).toContain('does not parse')
  })

  it('never reads a theme above the repository root', () => {
    const outer = temp('theme-outer-')
    const repo = join(outer, 'repo')

    mkdirSync(join(outer, '.kaynooo'), { recursive: true })
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(outer, '.kaynooo', 'theme.json'), JSON.stringify({ colors: { accent: 'red' } }))

    expect(loadTheme({ ...world(), from: repo }).theme.colors.accent).toBe('cyan')
  })
})

describe('colour specs', () => {
  const colors = createColors({ stream: { isTTY: true }, env: {} })

  it('accepts names, hex, numbers and several of them', () => {
    expect(isColorSpec('cyan')).toBe(true)
    expect(isColorSpec('bold redBright')).toBe(true)
    expect(isColorSpec('#1a2B3c')).toBe(true)
    expect(isColorSpec(208)).toBe(true)
    expect(isColorSpec(300)).toBe(false)
    expect(isColorSpec('#12')).toBe(false)
    expect(isColorSpec('chartreuse')).toBe(false)
    expect(isColorSpec('')).toBe(false)
  })

  it('draws each kind of spec', () => {
    expect(tinted(colors, 'green')('x')).toBe('\x1B[32mx\x1B[39m')
    expect(tinted(colors, 'bold green')('x')).toContain('\x1B[1m')
    expect(tinted(colors, '#ff0000')('x')).toContain('38;2;255;0;0')
    expect(tinted(colors, 208)('x')).toContain('38;5;208')
  })
})

describe('loadTheme, hostile input', () => {
  it('ignores a theme that is not a regular file', () => {
    const where = world()

    mkdirSync(join(where.from, '.kaynooo', 'theme.json'), { recursive: true })

    expect(loadTheme(where).sources).toEqual([])
    expect(where.warnings[0]).toContain('not a regular file')
  })

  it('ignores a theme too large to be one', () => {
    const where = world(undefined, { colors: { accent: 'red' }, padding: 'x'.repeat(70 * 1024) })

    expect(loadTheme(where).theme.colors.accent).toBe('cyan')
    expect(where.warnings[0]).toContain('not a regular file')
  })

  it('takes no inherited name as a colour, a preset or a bin', () => {
    const where = world({ colors: { toString: 'red', constructor: 'red', ['__proto__']: 'red' }, bins: { toString: 'red' } })
    const { theme } = loadTheme({ ...where, env: {} })

    expect(where.warnings.filter(message => message.includes('no colour'))).toHaveLength(3)
    expect(Object.getOwnPropertyDescriptor(theme.bins, 'toString')?.value).toBe('red')
    expect(loadTheme({ ...world(), env: { KIT_THEME: 'constructor' } }).preset).toBe('default')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('reads the file KIT_THEME names, and nothing else', () => {
    const where = world({ colors: { accent: 'red' } })
    const file = join(where.from, 'mine.json')

    writeFileSync(file, JSON.stringify({ colors: { accent: 'green' } }))

    expect(loadTheme({ ...where, env: { KIT_THEME: file } }).theme.colors.accent).toBe('green')
  })
})
