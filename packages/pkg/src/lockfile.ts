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
