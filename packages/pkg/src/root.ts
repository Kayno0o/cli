import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The nearest folder, from `from` up to the filesystem root, where `has` holds; undefined when none does.
export function nearestFolder(from: string, has: (folder: string) => boolean): string | undefined {
  for (let at = from; ; at = dirname(at)) {
    if (has(at))
      return at

    if (at === dirname(at))
      return undefined
  }
}

export function nearestWith(from: string, file: string): string | undefined {
  return nearestFolder(from, folder => existsSync(join(folder, file)))
}
