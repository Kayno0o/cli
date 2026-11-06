import { existsSync, statSync } from 'node:fs'
import { fail } from '@kaynooo/cli-kit'
import { lines, need, probe } from './proc'

export type Format = 'tar' | 'zip'

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

const TAR_SUFFIXES = ['.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz', '.tar.zst', '.tzst']
// mode, owner/group, size, date, time, then the name, which may hold spaces.
const TAR_LINE = /^([-dlhcbpsC])(\S{9}) \S+ +(\d+) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})? (.+)$/
const ZIP_LINE = /^\s*(\d+)\s+(\S+) (\d{2}:\d{2})\s+(\S.*)$/
const SYMLINK_ARROW = ' -> '
const HARDLINK_TO = / link to .*$/
const LEADING_DOT = /^(?:\.\/)+/
const TRAILING_SLASHES = /\/+$/
const ZIP_GLOB = /[*?[\]\\]/g

export function formatOf(file: string): Format | undefined {
  const name = file.toLowerCase()

  if (name.endsWith('.zip'))
    return 'zip'

  return TAR_SUFFIXES.some(suffix => name.endsWith(suffix)) ? 'tar' : undefined
}

// GNU tar picks gzip, bzip2 and xz from the file itself; zstd it is told.
export function tarFlags(file: string): string[] {
  const name = file.toLowerCase()

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

    const [, type, permissions, size, date, time, name] = found as unknown as [string, string, string, string, string, string, string]
    const { raw, target } = splitName(type, name)
    const path = clean(raw)

    if (path === '' || path === '.')
      continue

    entries.push({ path, raw, kind: kindOf(type), size: Number(size), mode: `${type}${permissions}`, modified: `${date} ${time}`, ...target === undefined ? {} : { target } })
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
    const path = clean(raw)

    if (path !== '')
      entries.push({ path, raw, kind: raw.endsWith('/') ? 'dir' : 'file', size: Number(size), mode: '-', modified: `${date} ${time}` })
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

// Opens the archive and lists what it holds, ending the command when it cannot.
export async function readEntries(file: string): Promise<Entry[]> {
  if (!existsSync(file) || !statSync(file).isFile())
    return fail(`'${file}' is not a file`, 1)

  const format = formatOf(file)

  if (format === undefined)
    return fail(`'${file}' is not an archive arc can read: it lists .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz, .tar.zst and .zip`, 1)

  need(format === 'zip' ? 'unzip' : 'tar')

  const listed = format === 'zip' ? await probe(['unzip', '-l', file]) : await probe(['tar', '-tvf', file, ...tarFlags(file)])

  if (listed.code !== 0)
    return fail(`could not read '${file}': is it damaged?`, 1)

  return withParents(format === 'zip' ? parseZip(listed.stdout) : parseTar(listed.stdout))
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
