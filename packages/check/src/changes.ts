import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { $ } from 'bun'

// The size and modification time of every file git sees as changed or new under dir, undefined outside a repository; reading no content keeps it cheap on a dirty tree.
export async function dirtyFiles(dir: string): Promise<Map<string, string> | undefined> {
  const listed = await $`git ls-files -z --modified --others --exclude-standard`.cwd(dir).quiet().nothrow()

  if (listed.exitCode !== 0)
    return undefined

  const files = new Map<string, string>()

  for (const path of listed.stdout.toString().split('\0').filter(Boolean)) {
    try {
      const { size, mtimeMs } = await stat(join(dir, path))

      files.set(path, `${size}:${mtimeMs}`)
    }
    catch {
      files.set(path, '')
    }
  }

  return files
}

export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path)
}
