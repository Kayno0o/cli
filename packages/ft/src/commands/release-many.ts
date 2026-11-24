import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { git } from '../git'
import { LEVELS, VERSION } from './release-version'

export interface Target {
  folder: string
  level: string
}

// `a,b:minor`: each folder with the level after its colon, else the one given to the command.
export function parseTargets(spec: string, level: string): Target[] {
  return spec.split(',').filter(part => part !== '').map((part) => {
    const [folder = '', own] = part.split(':')
    const chosen = own ?? level

    if (folder === '' || (!LEVELS.has(chosen) && !VERSION.test(chosen)))
      fail(`${part} is no folder[:level] in --package`)

    return { folder, level: chosen }
  })
}

// The published packages of the workspace, in folder order.
export async function publishable(): Promise<string[]> {
  const root = join(await git(['rev-parse', '--show-toplevel']), 'packages')
  const folders = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).toSorted()
  const found: string[] = []

  for (const folder of folders) {
    const file = Bun.file(join(root, folder, 'package.json'))

    if (await file.exists() && (await file.json() as { private?: boolean }).private !== true)
      found.push(folder)
  }

  return found
}

// Publishable packages that have commits under `packages/<name>` since their last `<name>-v*` tag (or since the beginning if never tagged).
export async function changedPackages(): Promise<{ folder: string, since: string | undefined }[]> {
  const root = await git(['rev-parse', '--show-toplevel'])
  const all = await publishable()
  const changed: { folder: string, since: string | undefined }[] = []

  for (const folder of all) {
    const tagRes = await $`git describe --tags --match ${`${folder}-v*`} --abbrev=0`.cwd(root).quiet().nothrow()
    const since = tagRes.exitCode === 0 ? tagRes.text().trim() || undefined : undefined
    const range = since === undefined ? 'HEAD' : `${since}..HEAD`
    const logRes = await $`git log -n 1 --oneline ${range} -- ${`packages/${folder}`}`.cwd(root).quiet().nothrow()

    if (logRes.exitCode === 0 && logRes.text().trim() !== '')
      changed.push({ folder, since })
  }

  return changed
}
