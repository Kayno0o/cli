import type { Manager } from './pin'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { LOCKFILES } from './pin'

export const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

export type Kind = typeof KINDS[number]

export interface Consumer {
  // The folder holding the package.json, relative to the root scanned.
  dir: string
  path: string
  kind: Kind
  spec: string
  // The manager its nearest lockfile pins, bun when there is none.
  manager: Manager
}

// Folders never holding a consumer of their own.
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'vendor', 'target', 'coverage'])
const MAX_DEPTH = 5
// Specs naming a local copy rather than a registry version.
const LOCAL_SPEC = /^(?:workspace|link|file|portal):/

function packageFiles(dir: string, depth: number, found: string[]): string[] {
  let entries

  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return found
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'package.json')
      found.push(join(dir, entry.name))
    else if (entry.isDirectory() && depth < MAX_DEPTH && !entry.name.startsWith('.') && !SKIPPED.has(entry.name))
      packageFiles(join(dir, entry.name), depth + 1, found)
  }

  return found
}

function managerFor(dir: string, root: string): Manager {
  for (let at = dir; ; at = dirname(at)) {
    const lockfile = LOCKFILES.find(([file]) => existsSync(join(at, file)))

    if (lockfile !== undefined)
      return lockfile[1]

    if (at === root || at === dirname(at))
      return 'bun'
  }
}

// Every package.json under the root declaring the package, sorted by folder, a `node_modules` or dot folder never entered.
export function findConsumers(name: string, root: string): Consumer[] {
  const consumers: Consumer[] = []

  for (const path of packageFiles(root, 0, []).sort()) {
    let manifest: Partial<Record<Kind, Record<string, string>>>

    try {
      manifest = JSON.parse(readFileSync(path, 'utf8')) as typeof manifest
    }
    catch {
      continue
    }

    const kind = KINDS.find(each => typeof manifest[each]?.[name] === 'string')
    const spec = kind === undefined ? undefined : manifest[kind]?.[name]

    if (kind !== undefined && spec !== undefined)
      consumers.push({ dir: relative(root, dirname(path)) || '.', path, kind, spec, manager: managerFor(dirname(path), root) })
  }

  return consumers
}

export function isLocal(consumer: Consumer): boolean {
  return LOCAL_SPEC.test(consumer.spec)
}

const KIND_FLAGS: Record<Kind, string[]> = { dependencies: [], devDependencies: ['--dev'], optionalDependencies: ['--optional'], peerDependencies: ['--peer'] }

// The `bun add` putting the version in the consumer, under the same kind of dependency.
export function addCommand(consumer: Consumer, name: string, version: string): string[] {
  return ['bun', 'add', ...KIND_FLAGS[consumer.kind], '--exact', '--no-cache', `${name}@${version}`]
}
