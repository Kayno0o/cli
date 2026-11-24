import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { runCommand } from './process'

const ENV_FILE = /^\.env(?:\..+)?$/
const DEPENDENCIES = new Set(['node_modules', 'vendor', '.venv'])
const TRAILING_SLASH = /\/$/
const PARENT = `..${sep}`

function moduleLinks(root: string, folder: string): { path: string, name: string }[] {
  const found: { path: string, name: string }[] = []

  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      found.push({ path: join(folder, entry.name), name: entry.name })
    else if (entry.isDirectory() && entry.name.startsWith('@'))
      found.push(...moduleLinks(root, join(folder, entry.name)))
  }

  return found
}

function workspaceTarget(root: string, path: string): string | undefined {
  try {
    const inRepo = relative(realpathSync(root), realpathSync(join(root, path)))

    return inRepo === '' || inRepo.startsWith(PARENT) || inRepo.split(sep).includes('node_modules') ? undefined : inRepo
  }
  catch {
    return undefined
  }
}

function hasWorkspaceLinks(root: string, folder: string): boolean {
  return moduleLinks(root, folder).some(({ path }) => workspaceTarget(root, path) !== undefined)
}

function linkModules(root: string, dir: string, folder: string): string[] {
  const links: string[] = []

  mkdirSync(join(dir, folder), { recursive: true })

  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    const path = join(folder, entry.name)
    const link = join(dir, path)

    if (entry.isDirectory() && entry.name.startsWith('@')) {
      links.push(...linkModules(root, dir, path))

      continue
    }

    const workspace = entry.isSymbolicLink() ? workspaceTarget(root, path) : undefined

    symlinkSync(workspace === undefined ? join(root, path) : join(dir, workspace), link)
    links.push(link)
  }

  return links
}

/** Gitignored env files and dependency folders (`node_modules`, `vendor`, `.venv`) present in `root`. */
export async function linkedWorktreeEntries(root: string): Promise<string[]> {
  const ran = await runCommand(['git', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: root })

  if (ran.code !== 0)
    return []

  return ran.stdout.trim().split('\0').filter((entry) => {
    const folder = entry.endsWith('/')
    const name = basename(entry)

    return folder ? DEPENDENCIES.has(name) : ENV_FILE.test(name)
  }).map(entry => entry.replace(TRAILING_SLASH, ''))
}

/** Links `entries` from `root` into worktree `dir`, rebuilding workspace `node_modules` so workspace symlinks point to `dir`'s own packages. */
export function linkWorktreeEntries(root: string, dir: string, entries: string[]): string[] {
  const links: string[] = []

  for (const entry of entries) {
    const link = join(dir, entry)

    if (existsSync(link))
      continue

    mkdirSync(dirname(link), { recursive: true })

    if (basename(entry) === 'node_modules' && hasWorkspaceLinks(root, entry)) {
      links.push(...linkModules(root, dir, entry))

      continue
    }

    symlinkSync(join(root, entry), link)
    links.push(link)
  }

  return links
}
