import type { Manager } from './pin'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fail } from '@kaynooo/cli-kit'
import { LOCKFILES } from './pin'

export const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

export type Kind = typeof KINDS[number]

export interface Consumer {
  // The folder holding the package.json, relative to the root scanned.
  dir: string
  path: string
  kind: Kind
  spec: string
  // The dependency's own key when it differs from the package, as in `"kay": "npm:@kaynooo/kayjs@~1.77.0"`.
  alias?: string
  // The manager its nearest lockfile pins, bun when there is none.
  manager: Manager
}

// Folders never holding a consumer of their own.
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'vendor', 'target', 'coverage'])
const MAX_DEPTH = 5
// Specs that are not a registry version or range: workspace:, link:, file:, git+, github:, tarball URLs, npm: aliases, catalog: and owner/repo shorthands.
const LOCAL_SPEC = /[:/]/

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

// `npm:@scope/name@~1.2.3` as its target and the version range it asks for.
const ALIAS = /^npm:(@[^@/]+\/[^@/]+|[^@/]+)@(.+)$/

function readManifest(path: string): Partial<Record<Kind, Record<string, string>>> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<Record<Kind, Record<string, string>>>
  }
  catch {
    return undefined
  }
}

// Every package.json under the root declaring the package, by its own name or through an `npm:` alias of it, sorted by folder, a `node_modules` or dot folder never entered.
export function findConsumers(name: string, root: string): Consumer[] {
  const consumers: Consumer[] = []

  for (const path of packageFiles(root, 0, []).sort()) {
    const manifest = readManifest(path)

    if (manifest === undefined)
      continue

    const seen = new Set<string>()

    for (const kind of KINDS) {
      for (const [key, spec] of Object.entries(manifest[kind] ?? {})) {
        const aliased = typeof spec === 'string' && key !== name && ALIAS.exec(spec)?.[1] === name

        // A key listed under two kinds, a library's dev and peer dependency, is one consumer: the first kind found.
        if (typeof spec === 'string' && (key === name || aliased) && !seen.has(key)) {
          seen.add(key)
          consumers.push({ dir: relative(root, dirname(path)) || '.', path, kind, spec, ...aliased ? { alias: key } : {}, manager: managerFor(dirname(path), root) })
        }
      }
    }
  }

  return consumers
}

// Shorter names than this are contained in too many others to hint at one.
const MIN_SIMILAR = 3

// The dependency names and alias targets under the root whose last segment holds, or is held by, that of `name`, for a hint when nothing matches it.
export function similarDependencies(name: string, root: string): string[] {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase()
  const found = new Set<string>()

  for (const path of packageFiles(root, 0, []).sort()) {
    const manifest = readManifest(path)

    for (const kind of KINDS) {
      for (const [key, spec] of Object.entries(manifest?.[kind] ?? {})) {
        const target = typeof spec === 'string' ? ALIAS.exec(spec)?.[1] : undefined

        for (const candidate of [key, target]) {
          const last = candidate?.slice(candidate.lastIndexOf('/') + 1).toLowerCase()

          if (candidate !== undefined && last !== undefined && candidate !== name && last.length >= MIN_SIMILAR && base.length >= MIN_SIMILAR && (last.includes(base) || base.includes(last)))
            found.add(candidate)
        }
      }
    }
  }

  return [...found].toSorted().slice(0, 5)
}

// Whether the dependency is on something other than a registry version, which a bump must not overwrite; an alias of the package is a registry version under another key.
export function isLocal(consumer: Consumer): boolean {
  return consumer.alias === undefined && LOCAL_SPEC.test(consumer.spec)
}

// The version an `npm:` alias asks for, or the spec as it is.
export function wantedVersion(consumer: Consumer): string {
  return consumer.alias === undefined ? consumer.spec : ALIAS.exec(consumer.spec)?.[2] ?? consumer.spec
}

const KIND_FLAGS: Record<Kind, string[]> = { dependencies: [], devDependencies: ['--dev'], optionalDependencies: ['--optional'], peerDependencies: ['--peer'] }

export const RANGE_PREFIX = /^[~^]/

// The `bun add` putting the version in the consumer, under the same kind of dependency; an alias keeps its key and the `~` or `^` of its range, a plain dependency is pinned exactly.
export function addCommand(consumer: Consumer, name: string, version: string): string[] {
  if (consumer.alias !== undefined) {
    const prefix = RANGE_PREFIX.exec(wantedVersion(consumer))?.[0] ?? ''

    return ['bun', 'add', ...KIND_FLAGS[consumer.kind], ...prefix === '' ? ['--exact'] : [], '--no-cache', `${consumer.alias}@npm:${name}@${prefix}${version}`]
  }

  return ['bun', 'add', ...KIND_FLAGS[consumer.kind], '--exact', '--no-cache', `${name}@${version}`]
}

export interface Declared {
  name: string
  kind: Kind
  spec: string
}

const REGISTRY_KINDS = KINDS.filter(kind => kind !== 'peerDependencies')

// The dependencies of a package.json that come from a registry, peer ranges and local or remote sources left out.
export function registryDependencies(text: string): Declared[] {
  let manifest: Partial<Record<Kind, Record<string, unknown>>>

  try {
    manifest = JSON.parse(text) as typeof manifest
  }
  catch {
    return fail('the package.json is not valid JSON')
  }

  return REGISTRY_KINDS.flatMap(kind => Object.entries(manifest?.[kind] ?? {}).flatMap(([name, spec]) => typeof spec === 'string' && !LOCAL_SPEC.test(spec) ? [{ name, kind, spec }] : []))
}
