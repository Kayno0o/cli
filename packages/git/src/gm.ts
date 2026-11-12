#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Hunk } from './conflicts'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { badUsage, fail, formatAge, isInteractive, jsonOption, marked, paint, parse, printJson, role, runMain, table } from '@kaynooo/cli-kit'
import { pick } from '@kaynooo/cli-kit/picker'
import { load } from './branch'
import { conflictHunks } from './conflicts'
import { git } from './git'

const USAGE = `gm [branch]: merges the branch into the current one with git merge --no-edit, saying what came in

Without a branch, on a terminal, picks one with a preview of what merging it would do (enter merges, ctrl-s squashes); without a terminal it lists the branches with that verdict. A merge in progress is refused here: \`gm --continue\` or \`gm --abort\`.
Staged changes are refused, and so are unstaged ones in files the merge changes; other unstaged edits stay as they are.
On a conflict every conflicted file is listed with its conflict regions and the exit is 1.`
const EXITS: ExitRow[] = [[0, 'it merged, the branch was already merged, or --dry-run found no conflict'], [1, 'a conflict, a dirty tree, an unknown branch, a refused step or git failed'], [2, 'outside a git repository or a usage error']]

const OPTIONS = {
  'abort': { type: 'boolean', description: 'give up the merge in progress', conflicts: ['continue', 'dry-run'] },
  'continue': { type: 'boolean', description: 'commit the merge in progress once no conflict marker is left', conflicts: ['abort', 'dry-run'] },
  'squash': { type: 'boolean', short: 's', description: 'stage the branch\'s changes without committing or recording a merge', conflicts: ['abort', 'continue', 'dry-run'] },
  'dry-run': { type: 'boolean', short: 'n', description: 'say whether the merge would conflict, and where, without touching the tree', conflicts: ['abort', 'continue'] },
  'json': jsonOption('{outcome, branch, into, sha?, commits?, files?: [{status, path, from?}], conflicts?: [{path, hunks: [{from, to, lines: [{line, text}]}]}]}, outcome being fast-forward, merge, squashed, up-to-date, conflict, clean (dry run), aborted or refused; with no branch an array of {name, remote, ahead, behind, outcome, conflicts: [path], when, subject}'),
} as const

const NOT_A_REPOSITORY = /not a git repository/i
const RENAME = /^[RC]\d*$/
const EDITOR_OFF = { ...process.env, GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' }

interface Conflict {
  path: string
  hunks: Hunk[]
}

async function ran(args: string[], env?: Record<string, string | undefined>): Promise<string> {
  const { code, stdout, stderr } = await git(args, env)

  if (code !== 0)
    fail(`git ${args[0]} failed:\n${(stderr || stdout).trim()}`, NOT_A_REPOSITORY.test(stderr) ? 2 : 1)

  return stdout
}

async function succeeds(args: string[]): Promise<boolean> {
  return (await git(args)).code === 0
}

async function currentBranch(): Promise<string> {
  const name = (await ran(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

  return name === 'HEAD' ? 'HEAD (detached)' : name
}

async function merging(): Promise<boolean> {
  return succeeds(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
}

// Every conflicted file of the repository, wherever gm runs from, its path relative to the current folder.
async function conflicted(): Promise<Conflict[]> {
  const top = (await ran(['rev-parse', '--show-toplevel'])).trim()
  const paths = (await ran(['diff', '--name-only', '--no-relative', '--diff-filter=U', '-z'])).split('\0').filter(Boolean).map(path => relative(process.cwd(), join(top, path)))

  return paths.map((path) => {
    try {
      return { path, hunks: conflictHunks(readFileSync(path, 'utf8')) }
    }
    catch {
      return { path, hunks: [] }
    }
  })
}

function conflictLines(conflicts: Conflict[]): string[] {
  return conflicts.flatMap(({ path, hunks }) => hunks.length === 0
    ? [`${role('path', process.stdout)(path)}: conflicted, no markers to show (deleted on a side, binary or a mode change)`]
    : hunks.flatMap(hunk => [role('path', process.stdout)(`${path}:${hunk.from}-${hunk.to}`), ...hunk.lines.map(({ line, text }) => `${line}  ${text}`), '']))
}

function fileLine(line: string): string {
  const [letter = '', from = '', to] = line.split('\t')

  return RENAME.test(letter) ? `  ${letter[0]} ${from} -> ${to}` : `  ${letter} ${from}`
}

function files(text: string) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [letter = '', from = '', to] = line.split('\t')

    return RENAME.test(letter) ? { status: letter[0] ?? letter, path: to ?? from, from } : { status: letter, path: from }
  })
}

// Reports a merge that left conflicts, exit 1.
function conflictReport(branch: string, into: string, conflicts: Conflict[], json: boolean, squash = false): number {
  if (json) {
    printJson({ outcome: 'conflict', branch, into, conflicts })

    return 1
  }

  console.log([marked('problem', `merging ${branch} into ${into} left ${conflicts.length} conflicted ${conflicts.length === 1 ? 'file' : 'files'}`, process.stdout), ...conflictLines(conflicts)].join('\n').trimEnd())
  console.log(squash ? '\nresolve the files and commit them with gc, or git reset --merge to give up' : '\nresolve the files, then gm --continue, or gm --abort')

  return 1
}

// Reports a finished merge from the commit it started at.
async function mergedReport(before: string, branch: string, into: string, json: boolean): Promise<number> {
  const sha = (await ran(['rev-parse', 'HEAD'])).trim()
  const parents = (await ran(['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').length - 1
  const outcome = parents > 1 ? 'merge' : 'fast-forward'
  const commits = Number((await ran(['rev-list', '--count', `${before}..HEAD`])).trim()) - (parents > 1 ? 1 : 0)
  const changed = await ran(['diff', '--name-status', '-M', before, 'HEAD'])

  if (json) {
    printJson({ outcome, branch, into, sha, commits, files: files(changed) })

    return 0
  }

  const count = `${commits} ${commits === 1 ? 'commit' : 'commits'}`
  const how = outcome === 'merge' ? `merge commit ${sha.slice(0, 7)}` : 'fast-forward'
  const list = changed.split('\n').filter(Boolean)

  console.log([marked('ok', `${into} <- ${branch}, ${how}, ${count}, ${list.length} ${list.length === 1 ? 'file' : 'files'} changed`, process.stdout), ...list.map(fileLine)].join('\n'))

  return 0
}

interface Verdict {
  outcome: 'clean' | 'conflict' | 'up-to-date'
  conflicts: string[]
}

// What merging the branch into HEAD would do, from git merge-tree: nothing is written to the tree or the index.
async function verdictOf(branch: string): Promise<Verdict> {
  if (await succeeds(['merge-base', '--is-ancestor', branch, 'HEAD']))
    return { outcome: 'up-to-date', conflicts: [] }

  const { code, stdout, stderr } = await git(['merge-tree', '--write-tree', '--name-only', 'HEAD', branch])

  if (code > 1)
    fail(`git merge-tree failed:\n${(stderr || stdout).trim()}`)

  const [, ...rest] = stdout.split('\n')

  return { outcome: code === 0 ? 'clean' : 'conflict', conflicts: [...new Set(rest.slice(0, Math.max(0, rest.indexOf(''))))] }
}

function verdictText(verdict: Verdict, tint = paint(process.stdout)): string {
  if (verdict.outcome === 'up-to-date')
    return tint.dim('merged already')

  return verdict.outcome === 'clean' ? tint.green('clean') : tint.red(`conflicts: ${verdict.conflicts.join(', ')}`)
}

// Reports a squash merge, whose changes wait in the index for a commit.
async function squashedReport(before: string, branch: string, into: string, json: boolean): Promise<number> {
  const commits = Number((await ran(['rev-list', '--count', `${before}..${branch}`])).trim())
  const changed = await ran(['diff', '--cached', '--name-status', '-M'])

  if (json) {
    printJson({ outcome: 'squashed', branch, into, commits, files: files(changed) })

    return 0
  }

  const list = changed.split('\n').filter(Boolean)

  console.log([marked('ok', `${branch} squashed into the index of ${into}: ${commits} ${commits === 1 ? 'commit' : 'commits'}, ${list.length} ${list.length === 1 ? 'file' : 'files'}, commit them with gc`, process.stdout), ...list.map(fileLine)].join('\n'))

  return 0
}

async function dryRun(branch: string, into: string, json: boolean): Promise<number> {
  const verdict = await verdictOf(branch)
  const code = verdict.outcome === 'conflict' ? 1 : 0

  if (json) {
    printJson({ outcome: verdict.outcome, branch, into, conflicts: verdict.conflicts.map(path => ({ path, hunks: [] })) })

    return code
  }

  if (verdict.outcome === 'up-to-date')
    console.log(`${branch} is already merged into ${into}`)
  else if (verdict.outcome === 'clean')
    console.log(marked('ok', `merging ${branch} into ${into} would not conflict`, process.stdout))
  else
    console.log([marked('problem', `merging ${branch} into ${into} would conflict in ${verdict.conflicts.length} ${verdict.conflicts.length === 1 ? 'file' : 'files'}`, process.stdout), ...verdict.conflicts.map(path => `  ${path}`)].join('\n'))

  return code
}

interface Candidate {
  name: string
  remote: boolean
  // Commits the branch has that the current one lacks, and the other way round.
  ahead: number
  behind: number
  when: string
  subject: string
}

// The branches to merge, the current one left out, each with how it stands against it.
async function candidates(): Promise<Candidate[]> {
  return Promise.all(load().all.map(async (branch) => {
    const [behind = '0', ahead = '0'] = (await ran(['rev-list', '--left-right', '--count', `HEAD...${branch.name}`])).trim().split('\t')

    return { name: branch.name, remote: branch.remote, ahead: Number(ahead), behind: Number(behind), when: formatAge(branch.date * 1000), subject: branch.subject }
  }))
}

const PREVIEW_COMMITS = 30

// The dry run of one branch: the commits that would come in, the files they touch and the verdict.
async function preview(branch: string): Promise<string> {
  const tint = paint({ isTTY: true })
  const [log, files, verdict] = await Promise.all([ran(['log', '--format=%h %s', `-${PREVIEW_COMMITS}`, `HEAD..${branch}`]), ran(['diff', '--name-status', '-M', `HEAD...${branch}`]), verdictOf(branch)])

  return [verdictText(verdict, tint), '', tint.bold('commits coming in'), log.trim() || tint.dim('none'), '', tint.bold('files'), files.trim() || tint.dim('none')].join('\n')
}

async function listing(json: boolean): Promise<number> {
  const found = await candidates()
  const verdicts = await Promise.all(found.map(async candidate => candidate.ahead === 0 ? { outcome: 'up-to-date', conflicts: [] } satisfies Verdict : verdictOf(candidate.name)))

  if (json) {
    printJson(found.map((candidate, at) => ({ ...candidate, outcome: verdicts[at]?.outcome, conflicts: verdicts[at]?.conflicts })))

    return 0
  }

  console.log(table(found.map((candidate, at) => [candidate.name, `${candidate.ahead} ahead, ${candidate.behind} behind`, verdictText(verdicts[at] as Verdict)])))

  return 0
}

async function choose(into: string): Promise<{ branch: string, squash: boolean } | undefined> {
  const tint = paint({ isTTY: true })
  const rows = (await candidates()).map(candidate => ({ hidden: [candidate.name], cells: [candidate.name, tint.green(`${candidate.ahead} ahead`), tint.red(`${candidate.behind} behind`), tint.dim(candidate.when), tint.dim(candidate.subject)] }))
  const picked = await pick(rows, { prompt: 'gm> ', header: `merge into ${tint.bold(into)}\nenter merge, ctrl-s merge --squash`, expect: ['ctrl-s'], searched: 1, preview: async hidden => preview(hidden[0] ?? '') })

  return picked === undefined || picked.hidden[0] === undefined ? undefined : { branch: picked.hidden[0], squash: picked.key === 'ctrl-s' }
}

// Staged changes would go into the merge commit, and an abort could not give back an unstaged edit in a file the merge changes; other unstaged edits stay as they are.
async function refuseUnsafeChanges(branch: string): Promise<void> {
  const paths = async (args: string[]) => (await ran([...args, '--name-only', '-z'])).split('\0').filter(path => path !== '')
  const staged = await paths(['diff', '--cached'])

  if (staged.length > 0)
    fail(`staged changes would go into the merge (${staged.join(', ')}): commit them first (gc), or unstage them (gu --staged)`, 1)

  const dirty = await paths(['diff'])

  if (dirty.length === 0)
    return

  const touched = new Set(await paths(['diff', '--no-renames', `HEAD...${branch}`]))
  const overlap = dirty.filter(path => touched.has(path))

  if (overlap.length > 0)
    fail(`uncommitted changes in files the merge changes (${overlap.join(', ')}): commit them first (gc), or set them aside as a patch (gu)`, 1)
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, USAGE, OPTIONS, { positionals: ['[branch]'], exits: EXITS, replaces: 'git merge and then git diff --name-only --diff-filter=U and reading each file for markers', examples: ['gm feature', ['gm --dry-run feature', 'whether it would conflict, and where'], ['gm --continue', 'commit once the conflicts are resolved'], ['gm --abort', 'give the merge up']] })
  const json = values.json === true
  const into = await currentBranch()

  if (values.abort === true || values.continue === true) {
    if (positionals.length > 0)
      badUsage('--abort and --continue take no branch')

    if (!await merging())
      fail('no merge in progress', 1)

    if (values.abort === true) {
      await ran(['merge', '--abort'])

      if (json)
        printJson({ outcome: 'aborted', into })
      else
        console.log(`merge into ${into} aborted`)

      return 0
    }

    const left = (await conflicted()).filter(conflict => conflict.hunks.length > 0)

    if (left.length > 0) {
      if (json)
        printJson({ outcome: 'refused', into, conflicts: left })
      else
        console.log([marked('problem', `conflict markers remain in ${left.map(conflict => conflict.path).join(', ')}`, process.stdout), ...conflictLines(left)].join('\n').trimEnd())

      return 1
    }

    const before = (await ran(['rev-parse', 'HEAD'])).trim()
    const incoming = (await ran(['rev-parse', 'MERGE_HEAD'])).trim()

    await ran(['add', '-A', '--', ...(await conflicted()).map(conflict => conflict.path)])
    await ran(['commit', '--no-edit'], EDITOR_OFF)

    return mergedReport(before, incoming.slice(0, 7), into, json)
  }

  const [named, ...extra] = positionals

  if (extra.length > 0)
    badUsage(`give one branch to merge\n\n${USAGE}`)

  if (named === undefined && values['dry-run'] === true)
    badUsage('--dry-run needs the branch to try')

  let branch = named
  let squash = values.squash === true

  if (branch === undefined) {
    if (await merging())
      fail('a merge is in progress: gm --continue once the conflicts are resolved, or gm --abort', 1)

    if (!isInteractive() || json)
      return listing(json)

    const chosen = await choose(into)

    if (chosen === undefined) {
      return 1
    }

    ({ branch, squash } = chosen)
  }

  if (branch.startsWith('-'))
    badUsage(`${branch} is no branch name`)

  if (!await succeeds(['rev-parse', '--verify', '-q', `${branch}^{commit}`]))
    fail(`no branch or commit named ${branch}`, 1)

  if (values['dry-run'] === true)
    return dryRun(branch, into, json)

  if (await merging())
    fail('a merge is already in progress: gm --continue once the conflicts are resolved, or gm --abort', 1)

  await refuseUnsafeChanges(branch)

  if (await succeeds(['merge-base', '--is-ancestor', branch, 'HEAD'])) {
    if (json)
      printJson({ outcome: 'up-to-date', branch, into })
    else
      console.log(`${into} already contains ${branch}`)

    return 0
  }

  const before = (await ran(['rev-parse', 'HEAD'])).trim()
  const merged = await git(squash ? ['merge', '--squash', branch] : ['merge', '--no-edit', branch], EDITOR_OFF)

  if (merged.code === 0)
    return squash ? squashedReport(before, branch, into, json) : mergedReport(before, branch, into, json)

  if (squash ? (await conflicted()).length > 0 : await merging())
    return conflictReport(branch, into, await conflicted(), json, squash)

  return fail(`git merge failed:\n${(merged.stderr || merged.stdout).trim()}`, NOT_A_REPOSITORY.test(merged.stderr) ? 2 : 1)
}

process.exitCode = await runMain({ name: 'gm', run: main })
