import type { Ran } from '@kaynooo/cli-kit'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fail, runCommand } from '@kaynooo/cli-kit'

const ENV_FILE = /^\.env(?:\..+)?$/
const DEPENDENCIES = new Set(['node_modules', 'vendor', '.venv'])
const TRAILING_SLASH = /\/$/
const CONTAINER = /(?:^|[\s;&|(])(?:docker\s+compose|docker-compose)\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*(?:exec|run)\b|(?:^|[\s;&|(])docker\s+exec\b/

export interface Checkout {
  root: string
  // The caller's folder within the repository, `api/`, empty at its root.
  prefix: string
}

function stdoutOf(ran: Ran): string {
  return Buffer.concat(ran.chunks.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.data)).toString().trim()
}

async function git(args: string[], cwd: string): Promise<Ran> {
  return runCommand(['git', ...args], { cwd })
}

// A container started from the compose project mounts the main checkout, so the command would never see the ref.
export function runsInContainer(command: string[]): boolean {
  return CONTAINER.test(command.join(' '))
}

export async function checkout(cwd: string): Promise<Checkout> {
  const ran = await git(['rev-parse', '--show-toplevel', '--show-prefix'], cwd)

  if (ran.code !== 0)
    fail('not inside a git repository')

  const [root = '', prefix = ''] = stdoutOf(ran).split('\n')

  return { root, prefix }
}

export async function resolveRef(root: string, ref: string): Promise<string> {
  const ran = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root)

  if (ran.code !== 0)
    fail(`no commit ${ref} in this repository`)

  return stdoutOf(ran)
}

// Repository paths of the --keep files, refused before anything is created when one is missing or outside the repository.
export function keptPaths(root: string, cwd: string, paths: string[]): string[] {
  return paths.map((path) => {
    const absolute = resolve(cwd, path)
    const inRepo = relative(root, absolute)

    if (inRepo === '' || inRepo.startsWith('..') || isAbsolute(inRepo))
      fail(`--keep ${path} is outside the repository`)

    if (!existsSync(absolute))
      fail(`--keep ${path}: no such file`)

    return inRepo
  })
}

// Env files and dependency folders the checkout has but git ignores, which a run needs and a fresh worktree lacks.
export async function linkedEntries(root: string): Promise<string[]> {
  const ran = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], root)

  if (ran.code !== 0)
    return []

  return stdoutOf(ran).split('\0').filter((entry) => {
    const folder = entry.endsWith('/')
    const name = basename(entry)

    return folder ? DEPENDENCIES.has(name) : ENV_FILE.test(name)
  }).map(entry => entry.replace(TRAILING_SLASH, ''))
}

export async function addWorktree(root: string, sha: string): Promise<string> {
  const dir = join(mkdtempSync(join(tmpdir(), 'base-')), basename(root))
  const ran = await git(['worktree', 'add', '--detach', dir, sha], root)

  if (ran.code !== 0) {
    rmSync(dirname(dir), { recursive: true, force: true })
    fail(`git worktree add failed:\n${ran.text.trim()}`)
  }

  return dir
}

export function copyKept(root: string, dir: string, paths: string[]): void {
  for (const path of paths) {
    const target = join(dir, path)

    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(root, path), target, { recursive: true })
  }
}

// Returns the links made, which are unlinked before the worktree is removed so nothing ever deletes through them.
export function linkEntries(root: string, dir: string, entries: string[]): string[] {
  const links: string[] = []

  for (const entry of entries) {
    const link = join(dir, entry)

    if (existsSync(link))
      continue

    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(root, entry), link)
    links.push(link)
  }

  return links
}

export async function removeWorktree(root: string, dir: string, links: string[]): Promise<void> {
  for (const link of links) {
    if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() === true)
      unlinkSync(link)
  }

  await git(['worktree', 'remove', '--force', dir], root)
  rmSync(dirname(dir), { recursive: true, force: true })
  await git(['worktree', 'prune'], root)
}
