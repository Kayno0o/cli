import type { Colors } from './style'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { findUp } from './config'
import { userConfigPath } from './user-config'

export type Role = 'accent' | 'id' | 'path' | 'label' | 'value'
export type Mark = 'ok' | 'warn' | 'problem' | 'note'
export type Status = 'passed' | 'failed' | 'running' | 'queued' | 'skipped'

// A colour is written as an ANSI name or style (`cyan`, `redBright`, `bold`), several of them (`bold cyan`), a 256-colour index or `#rrggbb`.
export type ColorSpec = string | number

type Env = Record<string, string | undefined>

export interface Theme {
  // The tint of each kind of data, of each mark and of each status.
  colors: Record<Role | Mark | Status, ColorSpec>
  // The symbol each mark and status draws on a terminal, the filled part of a bar and the part of it left empty where there is no colour.
  glyphs: Record<Mark | Status | 'bar' | 'barEmpty', string>
  // The tints a bin's header can take, picked by its name, and the bins that choose their own.
  accents: ColorSpec[]
  bins: Record<string, ColorSpec>
}

const DEFAULT: Theme = {
  colors: { accent: 'cyan', id: 'yellow', path: 'blue', label: 'dim', value: 'bold', ok: 'green', warn: 'yellow', problem: 'red', note: 'dim', passed: 'green', failed: 'red', running: 'cyan', queued: 'yellow', skipped: 'dim' },
  glyphs: { ok: '✓', warn: '▲', problem: '✗', note: '›', passed: '✓', failed: '✗', running: '●', queued: '○', skipped: '-', bar: '━', barEmpty: '─' },
  accents: ['cyan', 'magenta', 'green', 'blue', 'yellow', 'redBright'],
  bins: {},
}

const BRIGHT: Partial<Theme['colors']> = { accent: 'cyanBright', id: 'yellowBright', path: 'blueBright', label: 'white', value: 'bold whiteBright', ok: 'greenBright', warn: 'yellowBright', problem: 'redBright', note: 'white', passed: 'greenBright', failed: 'redBright', running: 'cyanBright', queued: 'yellowBright', skipped: 'white' }
const MONO: Partial<Theme['colors']> = { accent: 'bold', id: 'bold', path: 'underline', label: 'dim', value: 'bold', ok: 'bold', warn: 'bold', problem: 'bold', note: 'dim', passed: 'bold', failed: 'bold', running: 'bold', queued: 'dim', skipped: 'dim' }
const ASCII: Partial<Theme['glyphs']> = { ok: '+', warn: '!', problem: 'x', note: '>', passed: '+', failed: 'x', running: '*', queued: 'o', skipped: '-', bar: '#', barEmpty: '-' }

// Named themes, each a patch over the default one.
export const PRESETS: Record<string, { colors?: Partial<Theme['colors']>, glyphs?: Partial<Theme['glyphs']>, accents?: ColorSpec[] }> = {
  'default': {},
  'high-contrast': { colors: BRIGHT, accents: ['cyanBright', 'magentaBright', 'greenBright', 'blueBright', 'yellowBright', 'redBright'] },
  'mono': { colors: MONO, accents: ['bold'] },
  'ascii': { glyphs: ASCII },
}

const STYLES = new Set(['bold', 'dim', 'italic', 'underline', 'inverse', 'strikethrough', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey', 'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright', 'cyanBright', 'whiteBright'])
const HEX = /^#[0-9a-f]{6}$/i
const SPACES = /\s+/

// Whether `spec` reads as a colour, so a typo in a theme is told about instead of drawn as nothing.
export function isColorSpec(spec: unknown): spec is ColorSpec {
  if (typeof spec === 'number')
    return Number.isInteger(spec) && spec >= 0 && spec <= 255

  return typeof spec === 'string' && spec.trim() !== '' && spec.trim().split(SPACES).every(token => STYLES.has(token) || HEX.test(token))
}

// `colors` carrying the styles `spec` names, on top of whatever it already carries.
export function tinted(colors: Colors, spec: ColorSpec): Colors {
  if (typeof spec === 'number')
    return colors.ansi256(spec)

  return spec.trim().split(SPACES).reduce((chain, token) => HEX.test(token) ? chain.hex(token) : (chain as unknown as Record<string, Colors>)[token]!, colors)
}

export interface ThemeSettings {
  env?: Env
  from?: string
  home?: string
  // Where a problem with a theme file is told, once; stderr by default.
  warn?: (message: string) => void
}

export interface LoadedTheme {
  theme: Theme
  // The files read, the global one first, and the preset applied.
  sources: string[]
  preset: string
}

interface ThemeFile {
  preset?: unknown
  colors?: unknown
  glyphs?: unknown
  accents?: unknown
  bins?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The theme file at `path`, or undefined when there is none or it is not an object; a problem is told through `warn` rather than thrown.
function readThemeFile(path: string, warn: (message: string) => void): ThemeFile | undefined {
  if (!existsSync(path))
    return undefined

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))

    if (isRecord(parsed))
      return parsed

    warn(`${path} is not a JSON object, theme ignored`)
  }
  catch (error) {
    warn(`${path} does not parse (${error instanceof Error ? error.message : String(error)}), theme ignored`)
  }

  return undefined
}

function applyPreset(theme: Theme, name: unknown, warn: (message: string) => void, where: string): boolean {
  if (name === undefined)
    return false

  const preset = typeof name === 'string' ? PRESETS[name] : undefined

  if (preset === undefined) {
    warn(`${where}: no preset ${String(name)}, one of ${Object.keys(PRESETS).join(', ')}`)

    return false
  }

  Object.assign(theme.colors, preset.colors)
  Object.assign(theme.glyphs, preset.glyphs)

  if (preset.accents !== undefined)
    theme.accents = [...preset.accents]

  return true
}

// A key unknown to the theme, or a value that is no colour or no glyph, is told about and left out; the rest of the file still applies.
function applyFile(theme: Theme, file: ThemeFile, where: string, warn: (message: string) => void): void {
  if (isRecord(file.colors)) {
    for (const [key, value] of Object.entries(file.colors)) {
      if (!(key in DEFAULT.colors))
        warn(`${where}: no colour ${key}, one of ${Object.keys(DEFAULT.colors).join(', ')}`)
      else if (!isColorSpec(value))
        warn(`${where}: colour ${key} is not an ANSI name, \`#rrggbb\` or a number up to 255`)
      else
        theme.colors[key as keyof Theme['colors']] = value
    }
  }

  if (isRecord(file.glyphs)) {
    for (const [key, value] of Object.entries(file.glyphs)) {
      if (!(key in DEFAULT.glyphs))
        warn(`${where}: no glyph ${key}, one of ${Object.keys(DEFAULT.glyphs).join(', ')}`)
      else if (typeof value !== 'string' || value === '' || Bun.stringWidth(value) !== 1)
        warn(`${where}: glyph ${key} must be one character wide`)
      else
        theme.glyphs[key as keyof Theme['glyphs']] = value
    }
  }

  if (Array.isArray(file.accents) && file.accents.length > 0 && file.accents.every(isColorSpec))
    theme.accents = [...file.accents]
  else if (file.accents !== undefined)
    warn(`${where}: accents must be a non-empty list of colours`)

  if (isRecord(file.bins)) {
    for (const [bin, value] of Object.entries(file.bins)) {
      if (isColorSpec(value))
        theme.bins[bin] = value
      else
        warn(`${where}: bin ${bin} has no valid colour`)
    }
  }
}

// A project config is looked for up to the repository root or the home folder, never in a folder above them where a stranger's file could sit.
function endsWalk(home: string): (dir: string) => boolean {
  return dir => dir === resolve(home) || existsSync(join(dir, '.git'))
}

// The default theme, then the preset `KIT_THEME` names (or the file's own `preset`), then the global file `~/.config/kaynooo-cli/theme.json`, then the project's `.kaynooo/theme.json` found upward, each over the last. Reads JSON only, so a project file cannot run anything.
export function loadTheme({ env = process.env, from = process.cwd(), home = homedir(), warn = message => console.error(`warning: theme ${message}`) }: ThemeSettings = {}): LoadedTheme {
  const theme: Theme = { colors: { ...DEFAULT.colors }, glyphs: { ...DEFAULT.glyphs }, accents: [...DEFAULT.accents], bins: {} }
  const sources: string[] = []
  let preset = 'default'
  const files = [userConfigPath('theme', { home, xdg: env.XDG_CONFIG_HOME }), findUp(join('.kaynooo', 'theme.json'), from, endsWalk(home))]
    .flatMap(path => path === undefined ? [] : [path])
    .flatMap(path => [[path, readThemeFile(path, warn)] as const])
    .flatMap(([path, file]) => file === undefined ? [] : [{ path, file }])

  if (env.KIT_THEME !== undefined && env.KIT_THEME !== '') {
    if (applyPreset(theme, env.KIT_THEME, warn, 'KIT_THEME'))
      preset = env.KIT_THEME
  }
  else {
    // The nearest file naming a preset wins, so a project can pick one over the global choice.
    const named = files.findLast(({ file }) => file.preset !== undefined)

    if (named !== undefined && applyPreset(theme, named.file.preset, warn, named.path))
      preset = named.file.preset as string
  }

  for (const { path, file } of files) {
    applyFile(theme, file, path, warn)
    sources.push(path)
  }

  return { theme, sources, preset }
}

let current: LoadedTheme | undefined
let currentKey = ''

// The theme in force for this process, read once; it follows the folder and `KIT_THEME` it was read for, so a test changing either gets its own.
export function activeTheme(): LoadedTheme {
  const key = `${process.cwd()}\0${process.env.KIT_THEME ?? ''}\0${process.env.XDG_CONFIG_HOME ?? ''}`

  if (current === undefined || key !== currentKey) {
    current = loadTheme()
    currentKey = key
  }

  return current
}
