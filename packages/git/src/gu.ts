#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { badUsage, fail, formatAge, formatSize, isHumanTerminal, jsonOption, paint, parse, printJson, role, runMain, table } from '@kaynooo/cli-kit'
import { git } from './git'

const USAGE = `gu <path>...: undoes changes to the paths given, keeping what it takes away
gu ls [--json]: lists saved discard patches in .git/gu/
gu show [id] [--json]: shows a saved patch (newest by default)
gu pop [id] [--json]: applies and removes a saved patch (newest by default)
gu drop [id | --all] [--json]: removes a saved patch (or all of them)
gu revert <sha> [--json]: reverts a commit with git revert --no-edit

By default it discards the unstaged changes of the tracked paths, after saving them as a patch in the git folder (\`gu/<time>.patch\`) that \`gu pop\` or \`git apply\` puts back; a file added with git add -N leaves the index and the disk. --staged unstages the paths. --commit undoes the last commit, its changes left staged, refusing one already on the upstream or a merge.
Without a path it is a usage error, never "everything"; a path with no change is refused with nothing done.`

const EXITS: ExitRow[] = [[0, 'it undid what was asked'], [1, 'a path has no change, the commit is pushed, a patch cannot apply or git refused'], [2, 'a usage error or outside a git repository']]

const OPTIONS = {
  staged: { type: 'boolean', short: 's', description: 'unstage the paths, the working tree untouched' },
  commit: { type: 'boolean', short: 'c', description: 'undo the last commit, keeping its changes staged' },
  all: { type: 'boolean', short: 'a', description: 'with gu drop, remove all saved patches' },
  json: jsonOption('{action, paths?, saved?, commit?} of what was undone, saved being the patch of a discard'),
} as const

const SUBCOMMANDS = new Set(['ls', 'show', 'pop', 'drop', 'revert'])
const LITERAL = { ...process.env, GIT_LITERAL_PATHSPECS: '1' }
// A patch `git apply` takes whatever the config says: no external diff tool or textconv view, no colour, the a/ and b/ prefixes, paths from the top.
const PLAIN_PATCH = ['--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/']
const NOT_A_REPOSITORY = /not a git repository/i
const DIFF_HEADER = /^diff --git a\/.+ b\/(.+)$/gm
const DIGITS = /^\d+$/
const MAX_SAVED_PATCHES = 50
const MAX_PATCH_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface SavedPatch {
  id: string
  path: string
  mtimeMs: number
  size: number
  files: string[]
}

// Runs git, failing with its message and with what stands by then: nothing undone, unless a step past the first says otherwise.
async function checked(args: string[], standing = 'nothing undone'): Promise<string> {
  const { code, stdout, stderr } = await git(args, LITERAL)
  const command = args[0] === '-C' ? args[2] : args[0]

  if (code !== 0)
    fail(`git ${command} failed, ${standing}:\n${stderr.trim()}`, NOT_A_REPOSITORY.test(stderr) ? 2 : 1)

  return stdout
}

async function guFolder(): Promise<string> {
  return join(resolve((await checked(['rev-parse', '--git-dir'])).trim()), 'gu')
}

function patchFiles(text: string): string[] {
  return [...new Set([...text.matchAll(DIFF_HEADER)].map(match => match[1] ?? '').filter(Boolean))]
}

async function listPatches(): Promise<SavedPatch[]> {
  const folder = await guFolder()

  if (!existsSync(folder))
    return []

  const patches: SavedPatch[] = []

  for (const name of readdirSync(folder)) {
    if (!name.endsWith('.patch'))
      continue

    const path = join(folder, name)

    try {
      const info = statSync(path, { throwIfNoEntry: false })

      if (info === undefined)
        continue

      const files = patchFiles(readFileSync(path, 'utf8'))

      patches.push({ id: name.slice(0, -'.patch'.length), path, mtimeMs: info.mtimeMs, size: info.size, files })
    }
    catch {
      // Skip unreadable patches.
    }
  }

  return patches.toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id))
}

function prunePatches(folder: string): void {
  if (!existsSync(folder))
    return

  const cutoff = Date.now() - MAX_PATCH_AGE_MS
  const entries = readdirSync(folder)
    .filter(name => name.endsWith('.patch'))
    .map((name) => {
      const path = join(folder, name)

      return { path, mtimeMs: statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0 }
    })
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)

  for (const [index, entry] of entries.entries()) {
    if (index >= MAX_SAVED_PATCHES || entry.mtimeMs < cutoff)
      rmSync(entry.path, { force: true })
  }
}

function pickPatch(patches: SavedPatch[], selector: string | undefined): SavedPatch {
  if (patches.length === 0)
    fail('no saved patches in .git/gu/', 1)

  if (selector === undefined)
    return patches[0]!

  if (DIGITS.test(selector)) {
    const at = Number(selector)
    const hit = patches[at]

    if (hit !== undefined)
      return hit
  }

  const clean = selector.endsWith('.patch') ? selector.slice(0, -'.patch'.length) : selector
  const exact = patches.find(patch => patch.id === clean)

  if (exact !== undefined)
    return exact

  const matching = patches.filter(patch => patch.id.includes(clean))

  if (matching.length === 1)
    return matching[0]!

  if (matching.length > 1)
    fail(`${selector} matches ${matching.length} patches: ${matching.map(patch => patch.id).join(', ')}`, 1)

  return fail(`no saved patch matching ${selector}`, 1)
}

async function runSubcommand(sub: string, args: string[], json: boolean, dropAll: boolean): Promise<number> {
  if (sub === 'ls') {
    if (args.length > 0)
      badUsage('gu ls takes no arguments')

    const patches = await listPatches()

    if (json) {
      printJson(patches.map((patch, index) => ({ index, id: patch.id, path: patch.path, size: patch.size, mtime: new Date(patch.mtimeMs).toISOString(), files: patch.files })))

      return 0
    }

    if (patches.length === 0) {
      console.log(paint(process.stdout).dim('no saved patches'))

      return 0
    }

    const { dim } = paint(process.stdout)

    console.log(table(patches.map((patch, index) => [dim(String(index)), role('id', process.stdout)(patch.id), dim(formatAge(patch.mtimeMs)), dim(formatSize(patch.size)), patch.files.join(', ')])))

    return 0
  }

  if (sub === 'show') {
    if (args.length > 1)
      badUsage('gu show takes at most one patch id')

    const patch = pickPatch(await listPatches(), args[0])
    const text = readFileSync(patch.path, 'utf8')

    if (json) {
      printJson({ id: patch.id, path: patch.path, files: patch.files, patch: text })

      return 0
    }

    const viewer = isHumanTerminal(process.stdout) ? Bun.which('view') : null

    if (viewer !== null) {
      const child = Bun.spawn([viewer, '--diff'], { stdin: new TextEncoder().encode(text), stdout: 'inherit', stderr: 'inherit' })

      await child.exited

      return 0
    }

    process.stdout.write(text)

    return 0
  }

  if (sub === 'pop') {
    if (args.length > 1)
      badUsage('gu pop takes at most one patch id')

    const patch = pickPatch(await listPatches(), args[0])
    const top = (await checked(['rev-parse', '--show-toplevel'])).trim()
    const check = await git(['-C', top, 'apply', '--check', '--whitespace=nowarn', patch.path])

    if (check.code !== 0)
      fail(`patch ${patch.id} does not apply cleanly, kept in ${patch.path}:\n${check.stderr.trim()}`, 1)

    await checked(['-C', top, 'apply', '--whitespace=nowarn', patch.path], `patch kept in ${patch.path}`)
    rmSync(patch.path, { force: true })

    if (json)
      printJson({ action: 'pop', id: patch.id, paths: patch.files })
    else
      console.log(`restored ${patch.files.join(', ') || patch.id} from ${patch.id}`)

    return 0
  }

  if (sub === 'drop') {
    const patches = await listPatches()

    if (dropAll) {
      if (args.length > 0)
        badUsage('gu drop --all takes no patch id')

      for (const patch of patches)
        rmSync(patch.path, { force: true })

      if (json)
        printJson({ action: 'drop', dropped: patches.map(patch => patch.id) })
      else
        console.log(`dropped ${patches.length} saved ${patches.length === 1 ? 'patch' : 'patches'}`)

      return 0
    }

    if (args.length > 1)
      badUsage('gu drop takes at most one patch id')

    const patch = pickPatch(patches, args[0])

    rmSync(patch.path, { force: true })

    if (json)
      printJson({ action: 'drop', id: patch.id })
    else
      console.log(`dropped ${patch.id}`)

    return 0
  }

  // sub === 'revert'
  const [sha, ...extra] = args

  if (sha === undefined || extra.length > 0)
    badUsage('gu revert needs one commit sha: gu revert <sha>')

  if (sha.startsWith('-'))
    badUsage(`${sha} is not a commit sha`)

  const resolved = (await checked(['rev-parse', '--verify', `${sha}^{commit}`])).trim()
  const reverted = await git(['revert', '--no-edit', resolved], { ...process.env, GIT_EDITOR: 'true' })

  if (reverted.code !== 0)
    fail(`git revert failed:\n${(reverted.stderr || reverted.stdout).trim()}`, 1)

  const created = (await checked(['log', '-1', '--format=%h%x00%s'])).trim().split('\0')

  if (json)
    printJson({ action: 'revert', target: resolved, commit: { sha: created[0] ?? '', title: created[1] ?? '' } })
  else
    console.log(`reverted ${resolved.slice(0, 7)} as ${created[0] ?? ''} ${created[1] ?? ''}`)

  return 0
}

// The tracked paths among the given ones that differ, from the index (or from HEAD with `cached`).
async function changed(paths: string[], cached: boolean): Promise<string[]> {
  const out = await checked(['diff', ...cached ? ['--cached'] : [], '--name-only', '--no-relative', '-z', '--', ...paths])

  return out.split('\0').filter(Boolean)
}

async function undoCommit(): Promise<{ sha: string, title: string }> {
  const read = await git(['log', '-1', '--format=%h%x00%P%x00%s'], LITERAL)

  if (read.code !== 0)
    fail(NOT_A_REPOSITORY.test(read.stderr) ? 'not inside a git repository' : 'there is no commit to undo', NOT_A_REPOSITORY.test(read.stderr) ? 2 : 1)

  const [sha = '', parents = '', title = ''] = read.stdout.trim().split('\0')
  const count = parents.split(' ').filter(Boolean).length

  // A commit the upstream holds is shared: undoing it would leave the branch to be force-pushed.
  if ((await git(['merge-base', '--is-ancestor', 'HEAD', '@{upstream}'])).code === 0)
    fail(`${sha} is already on the upstream, undo it with gu revert ${sha} instead`, 1)

  if (count !== 1)
    fail(count === 0 ? `${sha} is the first commit, there is nothing before it to go back to` : `${sha} is a merge, gu does not undo those`, 1)

  await checked(['reset', '--soft', 'HEAD~1'])

  return { sha, title }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, USAGE, OPTIONS, {
    positionals: ['[path]...'],
    exits: EXITS,
    replaces: 'git restore, git restore --staged, git stash, git revert and git reset --soft HEAD~1 typed blind',
    examples: [
      ['gu src/a.ts', 'discard its unstaged changes, saved as a patch'],
      ['gu ls', 'list saved discard patches'],
      ['gu pop', 'restore the newest saved patch'],
      ['gu --staged src/a.ts', 'unstage it'],
      ['gu --commit', 'undo the last commit, changes staged'],
      ['gu revert abc1234', 'revert a commit cleanly'],
    ],
  })

  if (values.commit === true) {
    if (values.staged === true || values.all === true || positionals.length > 0)
      badUsage('--commit undoes the whole last commit: it takes no path and no --staged')

    const undone = await undoCommit()

    if (values.json === true)
      printJson({ action: 'commit', commit: undone })
    else
      console.log(`undid ${undone.sha} ${undone.title}, its changes are staged (git reflog keeps the commit)`)

    return 0
  }

  const [first, ...rest] = positionals
  const hasDashDash = argv.includes('--')

  if (!hasDashDash && values.staged !== true && first !== undefined && SUBCOMMANDS.has(first))
    return runSubcommand(first, rest, values.json === true, values.all === true)

  if (values.all === true)
    badUsage('--all only applies to gu drop')

  if (positionals.length === 0)
    badUsage('gu needs the paths to undo: gu src/a.ts (--commit undoes the last commit, gu ls lists saved patches)')

  const staged = values.staged === true
  // Every path must have a change, so a typo next to a real path discards nothing.
  const each = await Promise.all(positionals.map(async path => changed([path], staged)))
  const unchanged = positionals.filter((_, at) => each[at]?.length === 0)

  if (unchanged.length > 0)
    fail(`no ${staged ? 'staged' : 'unstaged'} change in ${unchanged.join(', ')}, nothing undone`, 1)

  const paths = [...new Set(each.flat())]

  if (staged) {
    // Before the first commit there is no HEAD to restore from, so the paths just leave the index.
    const hasHead = (await git(['rev-parse', '--verify', '-q', 'HEAD'], LITERAL)).code === 0

    await checked(hasHead ? ['restore', '--staged', '--', ...positionals] : ['rm', '--cached', '-r', '--quiet', '--', ...positionals])

    if (values.json === true)
      printJson({ action: 'unstage', paths })
    else
      console.log(`unstaged ${paths.join(', ')}`)

    return 0
  }

  const patch = await checked(['diff', ...PLAIN_PATCH, '--', ...positionals])
  const folder = await guFolder()
  const saved = join(folder, `${new Date().toISOString().replaceAll(':', '-')}.patch`)
  const top = (await checked(['rev-parse', '--show-toplevel'])).trim()

  mkdirSync(folder, { recursive: true })
  writeFileSync(saved, patch)
  prunePatches(folder)

  // Taking the patch back out of the working tree as it stands proves it holds the change before anything is lost.
  const reverts = await git(['-C', top, 'apply', '--check', '--reverse', '--whitespace=nowarn', saved])

  if (reverts.code !== 0)
    fail(`the patch saved to ${saved} would not put the change back, nothing discarded:\n${reverts.stderr.trim()}`, 1)

  // A path added with `git add -N` would be emptied by restore and kept in the index, where `git apply` refuses to create it again: it leaves the index and the disk instead.
  const intended = (await checked(['diff', '--name-only', '--no-relative', '--diff-filter=A', '-z', '--', ...positionals])).split('\0').filter(Boolean)
  const tracked = paths.filter(path => !intended.includes(path))

  const standing = `the change is saved to ${saved}`

  if (intended.length > 0) {
    await checked(['-C', top, 'rm', '--cached', '--quiet', '--', ...intended], standing)

    for (const path of intended)
      rmSync(join(top, path), { force: true })
  }

  if (tracked.length > 0)
    await checked(['-C', top, 'restore', '--', ...tracked], standing)

  if (values.json === true)
    printJson({ action: 'discard', paths, saved })
  else
    console.log(`discarded ${paths.join(', ')}, saved to ${saved} (gu pop or git apply puts it back)`)

  return 0
}

process.exitCode = await runMain({ name: 'gu', run: main })
