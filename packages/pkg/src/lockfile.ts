export interface Locked {
  name: string
  version: string
}

// A resolution naming a local or remote source rather than a registry version.
const NOT_REGISTRY = /^(?:workspace|link|file|github|git|http|https|npm):|^[\w.-]+\/[\w.-]+$/
const VERSION_SEPARATOR = /(?<=.)@/

// Every registry package a bun.lock pins, once per name and version, sorted.
export function parseBunLock(text: string): Locked[] {
  const lock = Bun.JSONC.parse(text) as { packages?: Record<string, unknown[]> } | null
  const seen = new Map<string, Locked>()

  for (const entry of Object.values(lock?.packages ?? {})) {
    const resolution = entry[0]

    if (typeof resolution !== 'string')
      continue

    const at = resolution.search(VERSION_SEPARATOR)
    const name = resolution.slice(0, at)
    const version = resolution.slice(at + 1)

    if (at !== -1 && !NOT_REGISTRY.test(version))
      seen.set(`${name}@${version}`, { name, version })
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || Bun.semver.order(a.version, b.version))
}
