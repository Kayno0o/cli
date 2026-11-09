import type { HeldSignals, Ran } from '@kaynooo/cli-kit'
import type { Subprocess } from 'bun'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { exitCodeOf, fail, holdSignals, runCommand } from '@kaynooo/cli-kit'

const WHITESPACE = /\s/
const ORIGIN_PREFIX = /^origin\//
const ENV_FILE = /^\.env(?:\..+)?$/
const DEPENDENCIES = new Set(['node_modules', 'vendor', '.venv'])
const TRAILING_SLASH = /\/$/
const PARENT = `..${sep}`
const BASE_DIR = /^base-\w{6}$/
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
  const ran = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], root)

  if (ran.code !== 0)
    fail(`no commit ${ref} in this repository`)

  return stdoutOf(ran)
}

// The remote ref the repository's default branch is: what origin's HEAD names (`origin/master`), else origin/main.
async function defaultRemoteRef(root: string): Promise<string> {
  const head = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root)

  return head.code === 0 && stdoutOf(head) !== '' ? stdoutOf(head) : 'origin/main'
}

// The ref `proof` runs before at when none is given: the merge base with origin's default branch (main unless origin's HEAD names another) when HEAD is on another branch that is ahead of it, else HEAD.
export async function defaultProofRef(root: string): Promise<string> {
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root)
  const remote = await defaultRemoteRef(root)

  if (branch.code !== 0 || stdoutOf(branch) === remote.replace(ORIGIN_PREFIX, ''))
    return 'HEAD'

  const base = await git(['merge-base', 'HEAD', remote], root)
  const head = await git(['rev-parse', 'HEAD'], root)

  return base.code === 0 && stdoutOf(base) !== stdoutOf(head) ? stdoutOf(base) : 'HEAD'
}

// Repository paths of the --keep files, refused before anything is created when one is missing or outside the repository.
export function keptPaths(root: string, cwd: string, paths: string[]): string[] {
  const realRoot = realpathSync(root)

  return paths.map((path) => {
    const absolute = resolve(cwd, path)

    if (!existsSync(dirname(absolute)))
      fail(`--keep ${path}: no such file`)

    const inRepo = relative(realRoot, join(realpathSync(dirname(absolute)), basename(absolute)))

    if (inRepo === '' || inRepo === '..' || inRepo.startsWith(PARENT) || isAbsolute(inRepo))
      fail(`--keep ${path} is outside the repository`)

    if (!existsSync(absolute))
      fail(`--keep ${path}: no such file`)

    return inRepo
  })
}

// Refuses a kept path that a committed symlink of the worktree would send outside it.
function checkNoSymlink(dir: string, path: string): void {
  let current = dir

  for (const part of dirname(path).split(sep)) {
    current = join(current, part)

    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() === true)
      fail(`--keep ${path} goes through the symlink ${relative(dir, current)} of the ref, which would write outside the worktree`)
  }
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
    checkNoSymlink(dir, path)

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

    if (basename(entry) === 'node_modules' && hasWorkspaceLinks(root, entry)) {
      links.push(...linkModules(root, dir, entry))

      continue
    }

    symlinkSync(join(root, entry), link)
    links.push(link)
  }

  return links
}

// The symlinks of a node_modules folder: its direct entries and those of its @scope folders.
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

// Where a node_modules symlink points when that is inside the repository but outside any node_modules: a workspace package.
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

// Rebuilds a node_modules folder entry by entry so a workspace link lands on the worktree's own copy of the package, not the main checkout's.
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

const STALE_AFTER = 24 * 60 * 60 * 1000

// Removes the temporary worktrees an earlier run left behind when it was killed without a chance to clean up, then forgets their git entries.
async function sweepStale(root: string): Promise<void> {
  for (const name of readdirSync(tmpdir())) {
    if (!BASE_DIR.test(name))
      continue

    const path = join(tmpdir(), name)
    const stat = lstatSync(path, { throwIfNoEntry: false })

    if (stat?.isDirectory() === true && stat.uid === process.getuid?.() && Date.now() - stat.mtimeMs > STALE_AFTER)
      rmSync(path, { recursive: true, force: true })
  }

  await git(['worktree', 'prune'], root)
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

export interface Run {
  code: number
  // Both streams joined, only when the run was captured.
  output: string
  // False when the command could not be started.
  started: boolean
  // True when it was killed for running past its timeout.
  timedOut?: boolean
}

// One argument holding spaces is a shell line, `base -- 'bun test a | tail'`.
export function shellCommand(given: string[]): string[] {
  const [only] = given

  return given.length === 1 && only !== undefined && WHITESPACE.test(only) ? ['sh', '-c', only] : given
}

const TIMEOUT_DRAIN_MS = 500

// Runs the command in a folder, inheriting the terminal or capturing both streams, the held signals passed on to it.
export async function runIn(dir: string, command: string[], signals: HeldSignals, capture = false, timeoutMs?: number): Promise<Run> {
  if (signals.signal !== undefined)
    return { code: exitCodeOf(null, signals.signal), output: '', started: true }

  let child: Subprocess

  try {
    child = Bun.spawn(command, { cwd: dir, stdin: 'inherit', stdout: capture ? 'pipe' : 'inherit', stderr: capture ? 'pipe' : 'inherit' })
  }
  catch (error) {
    return { code: 127, output: `cannot run ${command[0]}: ${error instanceof Error ? error.message : String(error)}`, started: false }
  }

  signals.forward(child)

  const chunks: Uint8Array[] = []
  let timedOut = false
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
  const collected = capture ? Promise.all([collect(child.stdout as ReadableStream<Uint8Array>, chunks), collect(child.stderr as ReadableStream<Uint8Array>, chunks)]) : Promise.resolve([])

  await child.exited
  clearTimeout(timer)

  // A grandchild the kill missed may hold the pipes open, so a timed out run waits a moment for the output, not for it to end.
  await (timedOut ? Promise.race([collected, Bun.sleep(TIMEOUT_DRAIN_MS)]) : collected)

  return { code: exitCodeOf(child.exitCode, child.signalCode ?? null), output: Buffer.concat(chunks).toString(), started: true, ...timedOut ? { timedOut } : {} }
}

// Keeps the chunks of both streams in the order they arrive.
async function collect(stream: ReadableStream<Uint8Array>, chunks: Uint8Array[]): Promise<void> {
  for await (const chunk of stream)
    chunks.push(chunk)
}

const FOLD_OVER = 120
const FOLD_HEAD = 20
const FOLD_TAIL = 80

// The output as printed: whole up to FOLD_OVER lines, else its first and last lines around a count of those left out.
export function folded(output: string): string {
  const lines = output.trimEnd().split('\n')

  if (lines.length <= FOLD_OVER)
    return lines.join('\n')

  return [...lines.slice(0, FOLD_HEAD), `... ${lines.length - FOLD_HEAD - FOLD_TAIL} lines omitted, --json has them all ...`, ...lines.slice(-FOLD_TAIL)].join('\n')
}

export interface WorktreeOptions {
  root: string
  prefix: string
  sha: string
  ref: string
  kept: string[]
  link: boolean
  // Held by the caller, who releases them, when it must see a signal that came during the run.
  signals?: HeldSignals
}

// Runs the callback in the caller's folder of a temporary worktree at the commit, signals held from its creation to its removal.
export async function inWorktree<T>(options: WorktreeOptions, body: (runDir: string, signals: HeldSignals) => Promise<T>): Promise<T> {
  const { root, prefix, sha, ref, kept, link } = options
  let links: string[] = []
  const signals = options.signals ?? holdSignals()

  await sweepStale(root)

  const dir = await addWorktree(root, sha)

  try {
    copyKept(root, dir, kept)
    links = link ? linkEntries(root, dir, await linkedEntries(root)) : []

    const runDir = join(dir, prefix)

    if (!existsSync(runDir))
      fail(`${prefix} does not exist at ${ref}`)

    return await body(runDir, signals)
  }
  finally {
    await removeWorktree(root, dir, links)

    if (options.signals === undefined)
      signals.release()
  }
}
