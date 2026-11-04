export interface Locked {
  name: string
  version: string
}

// A resolution naming a local or remote source rather than a registry version.
const NOT_REGISTRY = /^(?:workspace|link|file|github|git|http|https):|^[\w.-]+\/[\w.-]+$/
const VERSION_SEPARATOR = /(?<=.)@/
const NPM_ALIAS = 'npm:'

// The registry package a resolution pins, an `alias@npm:real@1.0.0` read as the real one; undefined for a local or remote source.
function split(resolution: string): Locked | undefined {
  const at = resolution.search(VERSION_SEPARATOR)

  if (at === -1)
    return undefined

  const target = resolution.slice(at + 1)

  if (target.startsWith(NPM_ALIAS))
    return split(target.slice(NPM_ALIAS.length))

  return NOT_REGISTRY.test(target) ? undefined : { name: resolution.slice(0, at), version: target }
}

// Every registry package a bun.lock pins, once per name and version, sorted.
export function parseBunLock(text: string): Locked[] {
  const lock = Bun.JSONC.parse(text) as { packages?: Record<string, unknown[]> } | null
  const seen = new Map<string, Locked>()

  for (const entry of Object.values(lock?.packages ?? {})) {
    const resolution = entry[0]

    if (typeof resolution !== 'string')
      continue

    const locked = split(resolution)

    if (locked !== undefined)
      seen.set(`${locked.name}@${locked.version}`, locked)
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || Bun.semver.order(a.version, b.version))
}

interface LockEntry {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

// bun.lock keys a nested copy as `parent/name`: the key to look in next is the parent's own, one package name (two for a scope) shorter.
function parentKey(key: string): string | undefined {
  const parts = key.split('/')
  const drop = parts.length > 1 && parts.at(-2)?.startsWith('@') ? 2 : 1

  return parts.length > drop ? parts.slice(0, -drop).join('/') : undefined
}

// The `name@version` of every registry package a production dependency or an optional one of a workspace reaches, development dependencies and what only they pull in left out.
export function productionPackages(text: string): Set<string> {
  const lock = Bun.JSONC.parse(text) as { workspaces?: Record<string, LockEntry>, packages?: Record<string, unknown[]> } | null
  const packages = lock?.packages ?? {}
  const reached = new Set<string>()
  const visited = new Set<string>()
  const pending: { name: string, from: string | undefined }[] = []

  for (const workspace of Object.values(lock?.workspaces ?? {})) {
    for (const name of Object.keys({ ...workspace.dependencies, ...workspace.optionalDependencies }))
      pending.push({ name, from: undefined })
  }

  while (pending.length > 0) {
    const { name, from } = pending.pop()!
    let scope = from
    let key = scope === undefined ? name : `${scope}/${name}`

    while (!(key in packages) && scope !== undefined) {
      scope = parentKey(scope)
      key = scope === undefined ? name : `${scope}/${name}`
    }

    const entry = packages[key]

    if (entry === undefined || visited.has(key))
      continue

    visited.add(key)

    const locked = typeof entry[0] === 'string' ? split(entry[0]) : undefined

    if (locked !== undefined)
      reached.add(`${locked.name}@${locked.version}`)

    const info = (entry[2] ?? {}) as LockEntry

    for (const dependency of Object.keys({ ...info.dependencies, ...info.optionalDependencies }))
      pending.push({ name: dependency, from: key })
  }

  return reached
}
