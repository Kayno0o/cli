import { existsSync, statSync } from 'node:fs'
import { fail } from '@kaynooo/cli-kit'
import { feedFile, lines, need, probe } from './proc'

export type Format = 'tar' | 'zip' | '7z' | 'rar'

export interface Entry {
  // The path with no leading ./ nor trailing slash.
  path: string
  // The name the archive itself holds it under, which tar and unzip match on.
  raw: string
  kind: 'file' | 'dir' | 'link'
  size: number
  mode: string
  modified: string
  target?: string
}

export interface TarVerboseEntry {
  raw: string
  owner: string
}

const TAR_SUFFIXES = ['.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tbz', '.tar.xz', '.txz', '.tar.zst', '.tzst']
// mode (with optional ACL/SELinux marker), owner/group, size (or major, minor for devices), date, time, then the name, which may hold spaces.
const TAR_LINE = /^([-dlhcbpsC])(\S{9,10}) (\S+) +(?:(\d+)|\d+, *\d+) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})? (.+)$/
const ZIP_LINE = /^\s*(\d+)\s+(\S+) (\d{2}:\d{2})\s+(\S.*)$/
const SYMLINK_ARROW = ' -> '
const HARDLINK_TO = / link to .*$/
const LEADING_DOT = /^(?:\.\/)+/
const TRAILING_SLASHES = /\/+$/
const BACKSLASHES = /\\/g
const ZIP_FOLDER = /[/\\]$/
const ZIP_GLOB = /[*?[\]\\]/g
const BLANK_BLOCK = /\r?\n\r?\n+/

export function formatOf(file: string): Format | undefined {
  const name = file.toLowerCase()

  if (name.endsWith('.zip'))
    return 'zip'

  if (name.endsWith('.7z'))
    return '7z'

  if (name.endsWith('.rar'))
    return 'rar'

  return TAR_SUFFIXES.some(suffix => name.endsWith(suffix)) ? 'tar' : undefined
}

// GNU tar picks gzip, bzip2 and xz from the file itself; zstd it is told.
export function tarFlags(file: string): string[] {
  const name = file.toLowerCase()

  return name.endsWith('.zst') || name.endsWith('.tzst') ? ['--zstd'] : []
}

// Explicit decompression flag for tar when reading from stdin, working on both GNU and BusyBox tar.
export function tarDecompressFlags(file: string): string[] {
  const name = file.toLowerCase()

  if (name.endsWith('.gz') || name.endsWith('.tgz'))
    return ['-z']

  if (name.endsWith('.bz2') || name.endsWith('.tbz2') || name.endsWith('.tbz'))
    return ['-j']

  if (name.endsWith('.xz') || name.endsWith('.txz'))
    return ['-J']

  return name.endsWith('.zst') || name.endsWith('.tzst') ? ['--zstd'] : []
}

// Escaped, as unzip reads its name arguments as patterns.
export function zipPattern(name: string): string {
  return name.replace(ZIP_GLOB, character => `\\${character}`)
}

function clean(raw: string): string {
  return raw.replace(LEADING_DOT, '').replace(TRAILING_SLASHES, '')
}

// A symbolic link is listed as `name -> target` and a hard link as `name link to other`.
function splitName(type: string, name: string): { raw: string, target?: string } {
  const arrow = type === 'l' ? name.indexOf(SYMLINK_ARROW) : -1

  if (arrow !== -1)
    return { raw: name.slice(0, arrow), target: name.slice(arrow + SYMLINK_ARROW.length) }

  return { raw: type === 'h' ? name.replace(HARDLINK_TO, '') : name }
}

function kindOf(type: string): Entry['kind'] {
  if (type === 'd')
    return 'dir'

  return type === 'l' ? 'link' : 'file'
}

export function parseTar(output: string): Entry[] {
  const entries: Entry[] = []

  for (const line of lines(output)) {
    const found = TAR_LINE.exec(line)

    if (found === null)
      continue

    const [, type, permissions, , size = '0', date, time, name] = found as unknown as [string, string, string, string, string | undefined, string, string, string]
    const { raw, target } = splitName(type, name)
    const path = clean(raw)

    if (path === '' || path === '.')
      continue

    entries.push({ path, raw, kind: kindOf(type), size: Number(size), mode: `${type}${permissions}`, modified: `${date} ${time}`, ...target === undefined ? {} : { target } })
  }

  return entries
}

// Extracts raw entry path and numeric owner/group from `tar --list --verbose --numeric-owner`.
export function parseTarVerbose(output: string): TarVerboseEntry[] {
  const entries: TarVerboseEntry[] = []

  for (const line of lines(output)) {
    const found = TAR_LINE.exec(line)

    if (found === null)
      continue

    const [, type, , owner, , , , name] = found as unknown as [string, string, string, string, string | undefined, string, string, string]
    const { raw } = splitName(type, name)

    entries.push({ raw, owner })
  }

  return entries
}

export function parseZip(output: string): Entry[] {
  const entries: Entry[] = []

  for (const line of lines(output)) {
    const found = ZIP_LINE.exec(line)

    if (found === null)
      continue

    const [, size, date, time, raw] = found as unknown as [string, string, string, string, string]
    const path = clean(raw.replace(BACKSLASHES, '/'))

    if (path !== '')
      entries.push({ path, raw, kind: ZIP_FOLDER.test(raw) ? 'dir' : 'file', size: Number(size), mode: '-', modified: `${date} ${time}` })
  }

  return entries
}

// The entries plus the folders only their paths imply, as an archive made from a file list holds no entry for them.
export function withParents(entries: Entry[]): Entry[] {
  const byPath = new Map(entries.map(entry => [entry.path, entry]))

  for (const { path } of entries) {
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
      const parent = path.slice(0, slash)

      if (!byPath.has(parent))
        byPath.set(parent, { path: parent, raw: `${parent}/`, kind: 'dir', size: 0, mode: 'd', modified: '' })
    }
  }

  return [...byPath.values()].toSorted((a, b) => a.path.localeCompare(b.path))
}

function entryKind(isDir: boolean, isLink = false): Entry['kind'] {
  if (isDir)
    return 'dir'

  return isLink ? 'link' : 'file'
}

function defaultMode(mode: string, isDir: boolean): string {
  if (mode !== '')
    return mode

  return isDir ? 'd' : '-'
}

export function parse7z(output: string): Entry[] {
  const entries: Entry[] = []
  const marker = output.indexOf('----------')
  const body = marker === -1 ? output : output.slice(marker + 10)

  for (const block of body.split(BLANK_BLOCK)) {
    const fields = new Map<string, string>()

    for (const line of lines(block)) {
      const eq = line.indexOf(' = ')

      if (eq !== -1)
        fields.set(line.slice(0, eq).trim(), line.slice(eq + 3).trim())
    }

    const raw = fields.get('Path')

    if (raw === undefined || raw === '')
      continue

    const path = clean(raw.replace(BACKSLASHES, '/'))

    if (path === '' || path === '.')
      continue

    const attrs = fields.get('Attributes') ?? ''
    const isDir = fields.get('Folder') === '+' || attrs.startsWith('D')
    const size = Number(fields.get('Size') ?? '0')
    const modified = (fields.get('Modified') ?? '').slice(0, 16)

    entries.push({ path, raw, kind: entryKind(isDir), size: Number.isNaN(size) ? 0 : size, mode: defaultMode(attrs, isDir), modified })
  }

  return entries
}

export function parseRar(output: string): Entry[] {
  const entries: Entry[] = []

  for (const block of output.split(BLANK_BLOCK)) {
    const fields = new Map<string, string>()

    for (const line of lines(block)) {
      const colon = line.indexOf(':')

      if (colon !== -1)
        fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
    }

    const raw = fields.get('name')

    if (raw === undefined || raw === '')
      continue

    const path = clean(raw.replace(BACKSLASHES, '/'))

    if (path === '' || path === '.')
      continue

    const type = (fields.get('type') ?? '').toLowerCase()
    const isDir = type === 'directory' || ZIP_FOLDER.test(raw)
    const isLink = type === 'symlink'
    const size = Number(fields.get('size') ?? '0')
    const modified = (fields.get('mtime') ?? '').slice(0, 16)
    const target = fields.get('target')

    entries.push({
      path,
      raw,
      kind: entryKind(isDir, isLink),
      size: Number.isNaN(size) ? 0 : size,
      mode: defaultMode(fields.get('attributes') ?? '', isDir),
      modified,
      ...target === undefined ? {} : { target },
    })
  }

  return entries
}

// Opens the archive and lists what it holds, ending the command when it cannot.
export async function readEntries(file: string, onBytes?: (bytes: number) => void): Promise<Entry[]> {
  if (!existsSync(file) || !statSync(file).isFile())
    return fail(`'${file}' is not a file`, 1)

  const format = formatOf(file)

  if (format === undefined)
    return fail(`'${file}' is not an archive arc can read: it lists .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz, .tar.zst, .zip, .7z and .rar`, 1)

  const tool: Record<Format, string> = { 'zip': 'unzip', 'tar': 'tar', '7z': '7z', 'rar': 'unrar' }

  need(tool[format])

  let listed

  if (format === 'tar' && onBytes !== undefined) {
    listed = await feedFile(file, ['tar', ...tarDecompressFlags(file), '-tvf', '-'], { capture: true, onBytes, stderr: 'ignore' })
  }
  else {
    const argv: Record<Format, string[]> = {
      'zip': ['unzip', '-l', file],
      'tar': ['tar', '-tvf', file, ...tarFlags(file)],
      '7z': ['7z', 'l', '-slt', file],
      'rar': ['unrar', 'vt', file],
    }

    listed = await probe(argv[format])
  }

  if (listed.code !== 0)
    return fail(`could not read '${file}': is it damaged?`, 1)

  const parsers: Record<Format, (out: string) => Entry[]> = {
    'zip': parseZip,
    'tar': parseTar,
    '7z': parse7z,
    'rar': parseRar,
  }

  return withParents(parsers[format](listed.stdout))
}

// What lies under `prefix`: the entries one level down, or every level with `recursive`. The prefix is cleaned the way paths are.
export function under(entries: Entry[], prefix: string, recursive: boolean): Entry[] | undefined {
  const base = clean(prefix)

  if (base === '')
    return recursive ? entries : entries.filter(entry => !entry.path.includes('/'))

  const self = entries.find(entry => entry.path === base)

  if (self === undefined)
    return undefined

  if (self.kind !== 'dir')
    return [self]

  const below = entries.filter(entry => entry.path.startsWith(`${base}/`))

  return recursive ? below : below.filter(entry => !entry.path.slice(base.length + 1).includes('/'))
}

export function cleanPath(path: string): string {
  return clean(path)
}
