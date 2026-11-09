#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { badUsage, fail, jsonOption, parse, printJson, runMain } from '@kaynooo/cli-kit'
import { git } from './git'

const USAGE = `gu <path>...: undoes changes to the paths given, keeping what it takes away

By default it discards the unstaged changes of the tracked paths, after saving them as a patch in the git folder (gu/<time>.patch) that \`git apply\` puts back. --staged unstages the paths and loses nothing. --commit undoes the last commit, its changes left staged, and refuses a commit that is already on the upstream or a merge.
Nothing is discarded without a path: gu alone is a usage error, never "everything". A path with no change is refused with nothing done.`

const EXITS: ExitRow[] = [[0, 'it undid what was asked'], [1, 'a path has no change, the commit is pushed or git refused'], [2, 'a usage error or outside a git repository']]

const OPTIONS = {
  staged: { type: 'boolean', short: 's', description: 'unstage the paths, the working tree untouched' },
  commit: { type: 'boolean', short: 'c', description: 'undo the last commit, keeping its changes staged' },
  json: jsonOption('{action, paths?, saved?, commit?} of what was undone, saved being the patch of a discard'),
} as const

const LITERAL = { ...process.env, GIT_LITERAL_PATHSPECS: '1' }
// A patch `git apply` takes whatever the config says: no external diff tool or textconv view, no colour, the a/ and b/ prefixes, paths from the top.
const PLAIN_PATCH = ['--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/']
const NOT_A_REPOSITORY = /not a git repository/i

async function checked(args: string[]): Promise<string> {
  const { code, stdout, stderr } = await git(args, LITERAL)

  if (code !== 0)
    fail(`git ${args[0]} failed, nothing undone:\n${stderr.trim()}`, NOT_A_REPOSITORY.test(stderr) ? 2 : 1)

  return stdout
}

// The tracked paths among the given ones that differ, from the index (or from HEAD with `cached`).
async function changed(paths: string[], cached: boolean): Promise<string[]> {
  const out = await checked(['diff', ...cached ? ['--cached'] : [], '--name-only', '-z', '--', ...paths])

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
    fail(`${sha} is already on the upstream, undo it with a revert instead`, 1)

  if (count !== 1)
    fail(count === 0 ? `${sha} is the first commit, there is nothing before it to go back to` : `${sha} is a merge, gu does not undo those`, 1)

  await checked(['reset', '--soft', 'HEAD~1'])

  return { sha, title }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, USAGE, OPTIONS, { positionals: ['[path]...'], exits: EXITS, replaces: 'git restore, git restore --staged and git reset --soft HEAD~1 typed blind', examples: [['gu src/a.ts', 'discard its unstaged changes, saved as a patch'], ['gu --staged src/a.ts', 'unstage it'], ['gu --commit', 'undo the last commit, changes staged']] })

  if (values.commit === true) {
    if (values.staged === true || positionals.length > 0)
      badUsage('--commit undoes the whole last commit: it takes no path and no --staged')

    const undone = await undoCommit()

    if (values.json === true)
      printJson({ action: 'commit', commit: undone })
    else
      console.log(`undid ${undone.sha} ${undone.title}, its changes are staged (git reflog keeps the commit)`)

    return 0
  }

  if (positionals.length === 0)
    badUsage('gu needs the paths to undo: gu src/a.ts (--commit undoes the last commit)')

  const staged = values.staged === true
  // Every path must have a change, so a typo next to a real path discards nothing.
  const each = await Promise.all(positionals.map(async path => changed([path], staged)))
  const unchanged = positionals.filter((_, at) => each[at]?.length === 0)

  if (unchanged.length > 0)
    fail(`no ${staged ? 'staged' : 'unstaged'} change in ${unchanged.join(', ')}, nothing undone`, 1)

  const paths = [...new Set(each.flat())]

  if (staged) {
    await checked(['restore', '--staged', '--', ...positionals])

    if (values.json === true)
      printJson({ action: 'unstage', paths })
    else
      console.log(`unstaged ${paths.join(', ')}`)

    return 0
  }

  const patch = await checked(['diff', ...PLAIN_PATCH, '--', ...positionals])
  const folder = join(resolve((await checked(['rev-parse', '--git-dir'])).trim()), 'gu')
  const saved = join(folder, `${new Date().toISOString().replaceAll(':', '-')}.patch`)
  const top = (await checked(['rev-parse', '--show-toplevel'])).trim()

  mkdirSync(folder, { recursive: true })
  writeFileSync(saved, patch)

  // Taking the patch back out of the working tree as it stands proves it holds the change before anything is lost.
  const reverts = await git(['-C', top, 'apply', '--check', '--reverse', '--whitespace=nowarn', saved])

  if (reverts.code !== 0)
    fail(`the patch saved to ${saved} would not put the change back, nothing discarded:\n${reverts.stderr.trim()}`, 1)

  await checked(['restore', '--', ...positionals])

  if (values.json === true)
    printJson({ action: 'discard', paths, saved })
  else
    console.log(`discarded ${paths.join(', ')}, saved to ${saved} (git apply puts it back)`)

  return 0
}

process.exitCode = await runMain({ name: 'gu', run: main })
