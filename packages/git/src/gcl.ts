#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, parse, printJson, readUserConfig, runMain, workspaceRoot } from '@kaynooo/cli-kit'
import { git } from './git'
import { repoState, toplevelOf } from './repos'
import { sync } from './sync'

const DEFAULT_FORGE = 'git.kaynooo.fr'

const USAGE = `gcl <repo> [dir]: clones a repository into the workspace folder and prints where it landed

<repo> is a URL, an scp-style address (git@host:owner/name.git), a local path or owner/name, which is read as https://${DEFAULT_FORGE}/owner/name.git (the \`forge\` key of ~/.config/kaynooo-cli/config.json names another host). Without <dir> the clone goes to <workspace>/<name>, the workspace being the one \`cli config\` reports.
When that folder already holds the repository, nothing is cloned: it is fetched and fast-forwarded as gf does. A folder holding anything else is refused.`

const EXITS: ExitRow[] = [[0, 'it cloned the repository, or found it and brought it up to date'], [1, 'git could not clone it, or the folder is taken'], [2, 'a usage error']]

const OPTIONS = {
  json: jsonOption('{url, path, branch, head, outcome}, outcome being cloned or existing'),
} as const

const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i
const SCP = /^[\w.-]+@[\w.-]+:/
const OWNER_NAME = /^[\w.-]+\/[\w.-]+$/
const GIT_SUFFIX = /\.git\/?$/
const TRAILING_SLASH = /\/+$/
const LAST_SEGMENT = /[/:]/

/** The address git clones from: a URL, scp address or local path as given, owner/name on the forge. */
export function urlOf(repo: string, forge: string): string {
  if (repo.startsWith('~/'))
    return join(homedir(), repo.slice(2))

  if (SCHEME.test(repo) || SCP.test(repo) || repo.startsWith('/') || repo.startsWith('.'))
    return repo

  if (OWNER_NAME.test(repo))
    return `https://${forge}/${repo.replace(GIT_SUFFIX, '')}.git`

  return fail(`${repo} is no URL and no owner/name`, 2)
}

/** The folder name a clone of the address gets: its last segment without .git. */
export function nameOf(url: string): string {
  return basename(url.replace(TRAILING_SLASH, '').split(LAST_SEGMENT).at(-1) ?? '').replace(GIT_SUFFIX, '')
}

// An address with the spellings that do not tell two clones apart taken out.
function same(url: string): string {
  return url.replace(TRAILING_SLASH, '').replace(GIT_SUFFIX, '').toLowerCase()
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, USAGE, OPTIONS, { positionals: ['<repo>', '[dir]'], exits: EXITS, replaces: 'git clone with the url and the folder typed out, then a cd', examples: ['gcl kaynooo/cli', ['gcl git@github.com:oven-sh/bun.git', 'an scp address'], ['gcl kaynooo/cli ~/tmp/cli', 'a folder of your own']] })
  const [repo, given] = positionals

  if (repo === undefined)
    fail('gcl needs the repository to clone: gcl owner/name', 2)

  const configured = readUserConfig('config').forge
  const url = urlOf(repo, typeof configured === 'string' && configured !== '' ? configured : DEFAULT_FORGE)
  const name = nameOf(url)

  if (name === '')
    fail(`no folder name can be taken from ${url}, give one: gcl ${repo} <dir>`, 2)

  const path = given === undefined ? join(workspaceRoot(), name) : resolve(given)
  let outcome: 'cloned' | 'existing' = 'cloned'

  if (existsSync(path) && (!statSync(path).isDirectory() || readdirSync(path).length > 0)) {
    if (!statSync(path).isDirectory() || await toplevelOf(path) !== realpathSync(path))
      fail(`${path} exists and is not a repository, nothing cloned`, 1)

    const origin = (await git(['-C', path, 'remote', 'get-url', 'origin'])).stdout.trim()

    if (same(origin) !== same(url))
      fail(`${path} is a clone of ${origin === '' ? 'nothing (no origin)' : origin}, not ${url}, nothing cloned`, 1)

    const synced = await sync(await repoState(path), { pull: true })

    if (synced.outcome === 'refused')
      fail(`${path} is already cloned but could not be brought up to date: ${synced.reason}`, 1)

    outcome = 'existing'
  }
  else {
    const cloned = await git(['clone', url, path])

    if (cloned.code !== 0)
      fail(`git clone failed:\n${cloned.stderr.trim()}`, 1)
  }

  const { status, head } = await repoState(path)
  const result = { url, path, branch: status?.branch ?? null, head: head?.sha ?? null, outcome }

  if (values.json === true)
    printJson(result)
  else
    console.log(path)

  if (values.json !== true)
    console.error(`${outcome === 'cloned' ? 'cloned' : 'already cloned'} ${url}${result.branch === null ? '' : ` on ${result.branch}`}${result.head === null ? '' : ` at ${result.head}`}`)

  return 0
}

if (import.meta.main)
  process.exitCode = await runMain({ name: 'gcl', run: main })
