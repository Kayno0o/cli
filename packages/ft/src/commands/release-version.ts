export const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const PARTS = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/
const LAST_NUMBER = /\d+$/

export interface Manifest { name?: string, version?: string, private?: boolean }

// The version a release tag carries, undefined for any other tag: `v1.2.0` with prefix `v`, `ft-v1.2.0` with `ft-v`.
export function taggedVersion(tag: string, prefix: string): string | undefined {
  const version = tag.slice(prefix.length)

  return tag.startsWith(prefix) && VERSION.test(version) ? version : undefined
}

// The version `bun pm version <level>` would set, as npm's semver.inc computes it.
export function nextVersion(current: string, level: string): string {
  if (VERSION.test(level))
    return level

  const [, major = '0', minor = '0', patch = '0', pre] = PARTS.exec(current) ?? []
  const [x, y, z] = [Number(major), Number(minor), Number(patch)]

  switch (level) {
    case 'major': return pre !== undefined && y === 0 && z === 0 ? `${x}.0.0` : `${x + 1}.0.0`
    case 'minor': return pre !== undefined && z === 0 ? `${x}.${y}.0` : `${x}.${y + 1}.0`
    case 'patch': return pre === undefined ? `${x}.${y}.${z + 1}` : `${x}.${y}.${z}`
    case 'premajor': return `${x + 1}.0.0-0`
    case 'preminor': return `${x}.${y + 1}.0-0`
    case 'prepatch': return `${x}.${y}.${z + 1}-0`
    default: {
      if (pre === undefined)
        return `${x}.${y}.${z + 1}-0`

      const numbered = LAST_NUMBER.exec(pre)

      return `${x}.${y}.${z}-${numbered === null ? `${pre}.0` : `${pre.slice(0, numbered.index)}${Number(numbered[0]) + 1}`}`
    }
  }
}
