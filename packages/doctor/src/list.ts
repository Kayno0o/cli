import type { Description } from '@kaynooo/cli-kit'
import type { Host } from './checks'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { CLI_FOLDER, xdgFolder } from '@kaynooo/cli-kit'
import { firstLine, ownBin, readJsonText, TOOLS } from './checks'

export interface Listed extends Partial<Description> {
  bin: string
  package: string
  installed: boolean
}

interface CachedEntry {
  mtimeMs: number
  size: number
  description: Description
}

const USAGE_WORD = /^Usage:\s*/

function cachePath(home: string): string {
  return join(xdgFolder(process.env.XDG_CACHE_HOME, join(home, '.cache')), CLI_FOLDER, 'bins-cache.json')
}

function loadCache(path: string): Record<string, CachedEntry> {
  try {
    return readJsonText<Record<string, CachedEntry>>(readFileSync(path, 'utf8')) ?? {}
  }
  catch {
    return {}
  }
}

function saveCache(path: string, entries: Record<string, CachedEntry>): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify(entries), { mode: 0o600 })
  }
  catch {}
}

// A bin as its own --help describes it under KIT_HELP=json; an install from before that prints its text help, whose first line is kept as the summary.
export async function describeBin(host: Host, bin: string, name: string, cache?: { entries: Record<string, CachedEntry>, dirty: boolean }): Promise<Listed> {
  if (host.which(bin) === null)
    return { bin, package: name, installed: false }

  const own = ownBin(host, name, bin)
  const info = own === undefined || cache === undefined ? undefined : statSync(own, { throwIfNoEntry: false })

  if (own !== undefined && info !== undefined && cache !== undefined) {
    const cached = cache.entries[own]

    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size)
      return { bin, package: name, installed: true, ...cached.description }
  }

  const ran = await host.run(own === undefined ? [bin, '--help'] : ['bun', own, '--help'], { KIT_HELP: 'json', NO_COLOR: '1' })
  const described = readJsonText<Description>(ran.stdout)

  if (described !== undefined) {
    if (own !== undefined && info !== undefined && cache !== undefined) {
      cache.entries[own] = { mtimeMs: info.mtimeMs, size: info.size, description: described }
      cache.dirty = true
    }

    return { bin, package: name, installed: true, ...described }
  }

  return { bin, package: name, installed: true, summary: firstLine(ran.stdout).replace(USAGE_WORD, '') }
}

export async function listBins(host: Host): Promise<Listed[]> {
  const path = cachePath(host.home)
  const cache = { entries: loadCache(path), dirty: false }
  const listed = await Promise.all(Object.entries(TOOLS).flatMap(([name, bins]) => bins.map(async bin => describeBin(host, bin, name, cache))))

  if (cache.dirty)
    saveCache(path, cache.entries)

  return listed
}

/** The bins a word narrows the list to: those whose name starts with it, or whose package, summary or "instead of" holds it, in any case. */
export function filterBins(listed: readonly Listed[], word: string | undefined): Listed[] {
  if (word === undefined || word === '')
    return [...listed]

  const wanted = word.toLowerCase()

  return listed.filter(each => each.bin.startsWith(wanted) || [each.package, each.summary, each.replaces].some(text => text?.toLowerCase().includes(wanted) === true))
}
