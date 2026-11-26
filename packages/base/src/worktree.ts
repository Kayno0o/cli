import type { HeldSignals, Ran } from '@kaynooo/cli-kit'
import type { Subprocess } from 'bun'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { exitCodeOf, fail, holdSignals, linkedWorktreeEntries, linkWorktreeEntries, role, runCommand, writeErr } from '@kaynooo/cli-kit'
import { formatError, parseErrors } from '@kaynooo/cli-kit/errors'

const WHITESPACE = /\s/
const ORIGIN_PREFIX = /^origin\//
const PARENT = `..${sep}`
const BASE_DIR = /^base-\w{6}$/
const CONTAINER = /(?:^|[\s;&|(])(?:docker\s+compose|docker-compose)\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*(?:exec|run)\b|(?:^|[\s;&|(])docker\s+exec\b/

export interface Checkout {
  root: string
  // The caller's folder within the repository, `api/`, empty at its root.
  prefix: string
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

  const [root = '', prefix = ''] = ran.stdout.trim().split('\n')

  return { root, prefix }
}

export async function resolveRef(root: string, ref: string): Promise<string> {
  const ran = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], root)

  if (ran.code !== 0)
    fail(`no commit ${ref} in this repository`)

  return ran.stdout.trim()
}

// The remote ref the repository's default branch is: what origin's HEAD names (`origin/master`), else origin/main.
async function defaultRemoteRef(root: string): Promise<string> {
  const head = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root)

  return head.code === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : 'origin/main'
}

export interface ChosenProofRef {
  ref: string
  reason: string
}

// Defaults to HEAD when the working tree has uncommitted changes (proving the dirty diff), else to merge-base with origin's default branch when on a branch ahead of it, else HEAD.
export async function chooseProofRef(root: string): Promise<ChosenProofRef> {
  const status = await git(['status', '--porcelain'], root)

  if (status.code === 0 && status.stdout.trim() !== '')
    return { ref: 'HEAD', reason: 'working tree has uncommitted changes' }

  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root)
  const remote = await defaultRemoteRef(root)

  if (branch.code !== 0 || branch.stdout.trim() === remote.replace(ORIGIN_PREFIX, ''))
    return { ref: 'HEAD', reason: 'on default branch' }

  const base = await git(['merge-base', 'HEAD', remote], root)
  const head = await git(['rev-parse', 'HEAD'], root)

  return base.code === 0 && base.stdout.trim() !== head.stdout.trim()
    ? { ref: base.stdout.trim(), reason: `merge-base with ${remote}` }
    : { ref: 'HEAD', reason: 'no commits ahead of default branch' }
}

export async function defaultProofRef(root: string): Promise<string> {
  return (await chooseProofRef(root)).ref
}

const SHELL_TOKEN_SEP = /[\s;|&()'"]+/

// Auto-discovers untracked/new files referenced in `command` (or all untracked files when `keepNew` is true) that do not exist at `sha`.
export async function autoKeptPaths(root: string, cwd: string, command: readonly string[], sha: string, keepNew: boolean): Promise<string[]> {
  const realRoot = realpathSync(root)
  const found = new Set<string>()

  if (keepNew) {
    const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z'], root)

    if (untracked.code === 0) {
      for (const rel of untracked.stdout.split('\0').filter(Boolean))
        found.add(rel)
    }
  }

  const tokens = command.flatMap(arg => WHITESPACE.test(arg) ? arg.split(SHELL_TOKEN_SEP) : [arg])

  for (const token of tokens) {
    if (token === '' || token.startsWith('-'))
      continue

    const absolute = resolve(cwd, token)

    if (!existsSync(absolute) || lstatSync(absolute, { throwIfNoEntry: false })?.isFile() !== true)
      continue

    const inRepo = relative(realRoot, join(realpathSync(dirname(absolute)), basename(absolute)))

    if (inRepo === '' || inRepo === '..' || inRepo.startsWith(PARENT) || isAbsolute(inRepo))
      continue

    // Only auto-keep files that do NOT exist at the target ref (e.g. a brand-new regression test).
    const atRef = await git(['cat-file', '-e', `${sha}:${inRepo}`], root)

    if (atRef.code !== 0)
      found.add(inRepo)
  }

  return [...found]
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

export async function linkedEntries(root: string): Promise<string[]> {
  return linkedWorktreeEntries(root)
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

export function linkEntries(root: string, dir: string, entries: string[]): string[] {
  return linkWorktreeEntries(root, dir, entries)
}

const STALE_AFTER = 24 * 60 * 60 * 1000

// Gives the owner write access to every folder of the tree, links left alone, so a folder the command made read-only can be emptied.
function makeWritable(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })

  if (stat?.isDirectory() !== true)
    return

  chmodSync(path, stat.mode | 0o700)

  for (const entry of readdirSync(path))
    makeWritable(join(path, entry))
}

// Removes a temporary folder, read-only ones inside included; one it still cannot remove is left with a warning, so cleanup never fails a run.
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  }
  catch {
    try {
      makeWritable(path)
      rmSync(path, { recursive: true, force: true })
    }
    catch (error) {
      writeErr(`${role('warn', process.stderr)('base:')} could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// Removes the temporary worktrees an earlier run left behind when it was killed without a chance to clean up, then forgets their git entries.
async function sweepStale(root: string): Promise<void> {
  for (const name of readdirSync(tmpdir())) {
    if (!BASE_DIR.test(name))
      continue

    const path = join(tmpdir(), name)
    const stat = lstatSync(path, { throwIfNoEntry: false })

    if (stat?.isDirectory() === true && stat.uid === process.getuid?.() && Date.now() - stat.mtimeMs > STALE_AFTER)
      removeTree(path)
  }

  await git(['worktree', 'prune'], root)
}

export async function removeWorktree(root: string, dir: string, links: string[]): Promise<void> {
  for (const link of links) {
    if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() === true)
      unlinkSync(link)
  }

  await git(['worktree', 'remove', '--force', dir], root)
  removeTree(dirname(dir))
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

// Formats command failure output using shared `errs` diagnostics when recognized, falling back to `folded`.
export function formattedFailure(output: string, cwd = process.cwd()): string {
  const { errors } = parseErrors(output)
  const relevant = errors.filter(error => error.severity === 'error')
  const list = relevant.length > 0 ? relevant : errors

  if (list.length > 0) {
    const shown = list.slice(0, 25).map(error => formatError(error, cwd))

    if (list.length > 25)
      shown.push(`... ${list.length - 25} more errors, --json has them all ...`)

    return shown.join('\n')
  }

  return folded(output)
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

export const ALLOW_CONTAINER = { type: 'boolean', description: 'run a command that matches a container (docker exec|run) anyway; it must then read the worktree itself, as a container mounts the main checkout' } as const

export function containerRefusal(subject: string): string {
  return `a container of the compose project mounts the main checkout, not the ${subject}, so the command would not run at the ref: run the tool on the host, check the ref out by hand, or pass --allow-container if the command reads the worktree itself`
}

export interface GoodRef {
  ref: string
  reason: string
}

// The latest tag reachable from the bad ref's parent, so a tag on the bad commit itself is skipped, else its merge-base with the upstream or the default remote branch; undefined when neither exists.
export async function defaultGoodRef(root: string, bad: string): Promise<GoodRef | undefined> {
  const tag = await git(['describe', '--tags', '--abbrev=0', `${bad}^`], root)

  if (tag.code === 0 && tag.stdout.trim() !== '')
    return { ref: tag.stdout.trim(), reason: 'latest tag' }

  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root)

  for (const remote of [upstream.code === 0 ? upstream.stdout.trim() : '', await defaultRemoteRef(root)]) {
    if (remote === '')
      continue

    const base = await git(['merge-base', bad, remote], root)

    if (base.code === 0 && base.stdout.trim() !== '')
      return { ref: base.stdout.trim(), reason: `merge-base with ${remote}` }
  }

  return undefined
}
