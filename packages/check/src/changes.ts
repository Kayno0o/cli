import { join } from 'node:path'
import { $ } from 'bun'

// The content hash of every file git sees as changed or new under dir, undefined outside a repository.
export async function dirtyFiles(dir: string): Promise<Map<string, string> | undefined> {
  const listed = await $`git ls-files -z --modified --others --exclude-standard`.cwd(dir).quiet().nothrow()

  if (listed.exitCode !== 0)
    return undefined

  const files = new Map<string, string>()

  for (const path of listed.stdout.toString().split('\0').filter(Boolean)) {
    const file = Bun.file(join(dir, path))

    files.set(path, await file.exists() ? String(Bun.hash(await file.arrayBuffer())) : '')
  }

  return files
}

export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path)
}
