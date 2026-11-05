import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fail } from '@kaynooo/cli-kit'
import { parseDotenv } from './dotenv'
import { SKIPPED } from './files'

export interface PinFinding {
  // A test file that renders a page or starts the app, relative to the app folder.
  file: string
  unpinned: string[]
}

export interface AppPins {
  app: string
  schema: string
  // The optional variables of the schema whose name says they reach outside.
  reaching: string[]
  // What no test env entry, preload or test file pins.
  unpinned: string[]
  // The rendering test files leaving some of the reaching variables to the developer's env.
  files: PinFinding[]
  // The local preload that drops what `.env` sets and `.env.test` does not, which pins every variable.
  preload?: string
}

const OPTIONAL = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*s\.Optional\(/gm
// A URL, key, token, secret, password, DSN or non-bare host, or the file holding one; the app's own public address only links back to itself.
const REACHING = /(?:URL|URI|TOKEN|KEY|SECRET|PASSWORD|DSN|_HOST)(?:_FILE)?$/
const SELF = /(?:^|_)(?:PUBLIC|SITE|BASE|APP)_URL$/
const RENDERS = /\b(?:testSite|proxyKeyTests)\s*\(/
// A test file that renders pages reaching none of the variables says so with this marker and a reason.
const NOT_NEEDED = /\/\/\s*ev pins:\s*none reached\b/
const OVERRIDE = /\boverrideEnv\s*\(/g
const KEY = /(?:^|[{,])\s*([A-Z_]\w*)\s*:/gi
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/
const ENV_TEST = /^\.env\.test(?:\.local)?$/
const TEST_ROOTS = ['tests', 'test', '__tests__', 'e2e', 'src']
const SCHEMA_CANDIDATES = ['src/env.ts', 'env.ts', 'src/env/index.ts']
const OPENERS = new Set(['(', '[', '{'])
const CLOSERS = new Set([')', ']', '}'])
const QUOTES = new Set(['\'', '"', '`'])

async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists()
}

async function walk(folder: string, keep: (name: string) => boolean): Promise<string[]> {
  const found: string[] = []
  let entries: Dirent[] = []

  try {
    entries = await readdir(folder, { withFileTypes: true })
  }
  catch {
    return found
  }

  for (const entry of entries) {
    if (SKIPPED.has(entry.name))
      continue

    const path = join(folder, entry.name)

    if (entry.isDirectory())
      found.push(...await walk(path, keep))
    else if (entry.isFile() && keep(entry.name))
      found.push(path)
  }

  return found.sort()
}

// The test files under the folders tests live in, which leaves an app's data folders alone.
async function testFiles(folder: string): Promise<string[]> {
  const found: string[] = []

  for (const root of TEST_ROOTS) {
    found.push(...await walk(join(folder, root), name => TEST_FILE.test(name)))
  }

  return found
}

// The text between the parenthesis opening at `open` and its match, skipping string literals.
function balanced(text: string, open: number): string {
  let depth = 0
  let quote = ''

  for (let index = open; index < text.length; index++) {
    const char = text[index] ?? ''

    if (quote !== '') {
      if (char === '\\')
        index++
      else if (char === quote)
        quote = ''
    }
    else if (QUOTES.has(char)) {
      quote = char
    }
    else if (OPENERS.has(char)) {
      depth++
    }
    else if (CLOSERS.has(char) && --depth === 0) {
      return text.slice(open + 1, index)
    }
  }

  return text.slice(open + 1)
}

// What is written at the top level of a text: nested brackets and string literals are blanked, so only the keys of the object itself remain.
function topLevel(text: string): string {
  let depth = 0
  let quote = ''
  let out = ''

  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? ''

    if (quote !== '') {
      if (char === '\\')
        index++
      else if (char === quote)
        quote = ''
    }
    else if (QUOTES.has(char)) {
      quote = char
    }
    else if (OPENERS.has(char)) {
      out += depth === 0 ? char : ''
      depth++
    }
    else if (CLOSERS.has(char)) {
      depth--
      out += depth === 0 ? char : ''
    }
    else if (depth <= 1) {
      out += char
    }
  }

  return out
}

// The variable names a test file gives another value through `overrideEnv(env, { NAME: ... })`; values are never looked at.
export function overriddenNames(source: string): Set<string> {
  const names = new Set<string>()

  for (const match of source.matchAll(OVERRIDE)) {
    const args = topLevel(balanced(source, match.index + match[0].length - 1))
    const object = args.slice(args.indexOf(',') + 1)

    for (const key of object.matchAll(KEY))
      names.add(key[1] ?? '')
  }

  return names
}

// The optional variables of a `defineEnv` schema, by name.
export function optionalNames(source: string): string[] {
  const start = source.indexOf('defineEnv(')

  return start === -1 ? [] : [...source.slice(start).matchAll(OPTIONAL)].map(match => match[1] ?? '')
}

export function reachesOutside(name: string): boolean {
  return REACHING.test(name) && !SELF.test(name)
}

async function schemaFile(folder: string): Promise<string | undefined> {
  for (const candidate of SCHEMA_CANDIDATES) {
    const path = join(folder, candidate)

    if (await exists(path) && (await readFile(path, 'utf8')).includes('defineEnv('))
      return path
  }

  return undefined
}

// The keys `.env.test` and `.env.test.local` set, even to an empty value; the values are dropped as parsed.
async function testEnvKeys(folder: string): Promise<Set<string>> {
  const keys = new Set<string>()

  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !ENV_TEST.test(entry.name))
      continue

    for (const line of parseDotenv(await readFile(join(folder, entry.name), 'utf8')).lines) {
      if (line.key !== undefined)
        keys.add(line.key)
    }
  }

  return keys
}

// A local test preload reading `.env` and writing process.env drops what the files set that `.env.test` does not, so no developer value reaches a test.
async function pinningPreload(folder: string): Promise<string | undefined> {
  const path = join(folder, 'bunfig.toml')

  if (!await exists(path))
    return undefined

  let config: { preload?: unknown, test?: { preload?: unknown } }

  try {
    config = Bun.TOML.parse(await readFile(path, 'utf8'))
  }
  catch {
    fail(`${path} is not valid TOML`)
  }

  const preloads = [config.test?.preload, config.preload].flat().filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('.'))

  for (const preload of preloads) {
    const file = join(folder, preload)

    if (!await exists(file))
      continue

    const source = await readFile(file, 'utf8')

    if (source.includes('.env') && source.includes('process.env'))
      return preload
  }

  return undefined
}

// Reads one app folder, or undefined when it declares no env schema.
export async function checkApp(folder: string, except: ReadonlySet<string> = new Set()): Promise<AppPins | undefined> {
  const schema = await schemaFile(folder)

  if (schema === undefined)
    return undefined

  const reaching = optionalNames(await readFile(schema, 'utf8')).filter(name => reachesOutside(name) && !except.has(name))
  const preload = await pinningPreload(folder)
  const app: AppPins = { app: folder, schema: relative(folder, schema), reaching, unpinned: [], files: [], ...preload !== undefined && { preload } }

  if (preload !== undefined)
    return app

  const fromEnv = await testEnvKeys(folder)
  const open = reaching.filter(name => !fromEnv.has(name))
  const anywhere = new Set<string>()

  for (const path of await testFiles(folder)) {
    const source = await readFile(path, 'utf8')
    const pinned = overriddenNames(source)

    for (const name of pinned)
      anywhere.add(name)

    const unpinned = open.filter(name => !pinned.has(name))

    if (RENDERS.test(source) && !NOT_NEEDED.test(source) && unpinned.length > 0)
      app.files.push({ file: relative(folder, path), unpinned })
  }

  app.unpinned = open.filter(name => !anywhere.has(name))

  return app
}
