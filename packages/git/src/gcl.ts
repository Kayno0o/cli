#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { configuredForge, fail, jsonOption, parse, printJson, readUserConfig, runMain, userConfigPath } from '@kaynooo/cli-kit'
import { askpass, NO_PROMPTS } from '@kaynooo/cli-kit/askpass'
import { git } from './git'
import { repoState, toplevelOf } from './repos'
import { sync } from './sync'

const USAGE = `gcl <repo> [dir]: clones a repository into the current folder and prints where it landed

<repo> is a URL, an scp-style address (\`git@host:port:owner/name\` read as \`ssh://git@host:port/owner/name\`), a local path or \`owner/name\`. Without <dir> the clone goes to ./<name>, as git clone does.
\`owner/name\` is cloned over ssh from the \`forgeSsh\` config key (\`git@host\` or \`ssh://git@host:port\`), anonymously over https from the \`forge\` config key (a host or a URL, forgeSsh's host when unset) when ssh fails or forgeSsh is unset; with neither key it is refused. Off a terminal git never asks for a password, through the terminal or a desktop window: it fails instead.
A folder that already holds the repository is fetched and fast-forwarded as gf does, not cloned again; one holding anything else is refused.`

const EXITS: ExitRow[] = [[0, 'it cloned the repository, or found it and brought it up to date'], [1, 'git could not clone it, or the folder is taken'], [2, 'a usage error']]

const OPTIONS = {
  json: jsonOption('{url, path, branch, head, outcome}, outcome being cloned or existing'),
} as const

const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i
const SCP = /^[\w.-]+@[\w.-]+:/
// `git@host:22022:owner/name`, the port git's scp syntax has no room for.
const SCP_WITH_PORT = /^([\w.-]+@[\w.-]+):(\d+):\/?(.+)$/
const OWNER_NAME = /^[\w.-]+\/[\w.-]+$/
const GIT_SUFFIX = /\.git\/?$/
const TRAILING_SLASH = /\/+$/
const LAST_SEGMENT = /[/:]/
// What git says when an https remote wants credentials it may not ask for, as a private repository does.
const AUTH_REFUSED = /could not read Username|Authentication failed|terminal prompts disabled|\b40[13]\b/i
const SSH_BASE_END = /[/:]$/
const SSH_HOST = /^(?:ssh:\/\/)?(?:[^@/]+@)?([\w.-]+)/

/** The address git clones from: a URL, scp address or local path as given, owner/name on the forge, a host served over https unless it names its scheme. */
export function urlOf(repo: string, forge: string | undefined): string {
  if (repo.startsWith('~/'))
    return join(homedir(), repo.slice(2))

  const withPort = SCP_WITH_PORT.exec(repo)

  if (withPort !== null)
    return `ssh://${withPort[1]}:${withPort[2]}/${withPort[3]}`

  if (SCHEME.test(repo) || SCP.test(repo) || repo.startsWith('/') || repo.startsWith('.'))
    return repo

  if (OWNER_NAME.test(repo)) {
    if (forge === undefined)
      return fail(`${repo} needs the forge it lives on: set forge (a host such as git.example.org) in ${userConfigPath('config')}`, 2)

    return `${SCHEME.test(forge) ? forge.replace(TRAILING_SLASH, '') : `https://${forge}`}/${repo.replace(GIT_SUFFIX, '')}.git`
  }

  return fail(`${repo} is no URL and no owner/name`, 2)
}

/** The ssh address of `owner/name` on a forge whose ssh address is `base`: `git@host` takes a colon, `ssh://git@host:port` a slash. */
export function sshUrlOf(repo: string, base: string): string {
  const separator = SCHEME.test(base) ? '/' : ':'

  return `${base}${SSH_BASE_END.test(base) ? '' : separator}${repo.replace(GIT_SUFFIX, '')}.git`
}

// A string config key, undefined when unset or empty.
function setting(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key]

  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The folder name a clone of the address gets: its last segment without .git. */
export function nameOf(url: string): string {
  return basename(url.replace(TRAILING_SLASH, '').split(LAST_SEGMENT).at(-1) ?? '').replace(GIT_SUFFIX, '')
}

// An address with the spellings that do not tell two clones apart taken out.
function same(url: string): string {
  return url.replace(TRAILING_SLASH, '').replace(GIT_SUFFIX, '').toLowerCase()
}

interface Target {
  repo: string
  url: string
  // The ssh address of an owner/name, on forgeSsh or else git@<forge>.
  sshUrl: string | undefined
  forgeSsh: string | undefined
  path: string
}

type Env = Record<string, string | undefined>

// Fetches and fast-forwards a folder already holding the repository, as gf does, and refuses one holding anything else; answers its origin.
async function update({ url, sshUrl, path }: Target, env: Env): Promise<string> {
  if (!statSync(path).isDirectory() || await toplevelOf(path) !== realpathSync(path))
    fail(`${path} exists and is not a repository, nothing cloned`, 1)

  const origin = (await git(['-C', path, 'remote', 'get-url', 'origin'])).stdout.trim()

  // an owner/name cloned over ssh before is the same repository
  if (same(origin) !== same(url) && (sshUrl === undefined || same(origin) !== same(sshUrl)))
    fail(`${path} is a clone of ${origin === '' ? 'nothing (no origin)' : origin}, not ${url}, nothing cloned`, 1)

  const synced = await sync(await repoState(path), { pull: true, env })

  if (synced.outcome === 'refused')
    fail(`${path} is already cloned but could not be brought up to date: ${synced.reason}`, 1)

  return origin
}

// Clones the repository, an owner/name over ssh first when forgeSsh names the forge's ssh address, then anonymously over https; answers the address cloned.
async function clone({ repo, url, sshUrl, forgeSsh, path }: Target, env: Env): Promise<string> {
  if (forgeSsh !== undefined && sshUrl !== undefined) {
    const overSsh = await git(['clone', sshUrl, path], env)

    if (overSsh.code === 0)
      return sshUrl

    // a public repository needs no login, and a private one ssh refused would only get a password prompt
    const overHttps = await git(['clone', url, path], { ...env, ...NO_PROMPTS })

    if (overHttps.code !== 0)
      fail(`git clone failed over ssh and over https:\n${overSsh.stderr.trim()}\n${overHttps.stderr.trim()}`, 1)

    return url
  }

  const cloned = await git(['clone', url, path], env)

  if (cloned.code === 0)
    return url

  if (sshUrl === undefined || !AUTH_REFUSED.test(cloned.stderr))
    fail(`git clone failed:\n${cloned.stderr.trim()}`, 1)

  return fail(`git clone failed:\n${cloned.stderr.trim()}\n${repo} may be private, which https refuses without a login: clone it over ssh, as gcl ${sshUrl}, or set forgeSsh in ~/.config/kaynooo-cli/config.json to the forge's ssh address so that owner/name does`, 1)
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, USAGE, OPTIONS, { positionals: ['<repo>', '[dir]'], exits: EXITS, replaces: 'git clone with the url typed out, then a cd', examples: ['gcl kaynooo/cli', ['gcl git@github.com:oven-sh/bun.git', 'an scp address'], ['gcl git@git.example.org:22022:kaynooo/cli', 'an scp address with a port'], ['gcl kaynooo/cli ~/tmp/cli', 'a folder of your own']] })
  const [repo, given] = positionals

  if (repo === undefined)
    fail('gcl needs the repository to clone: gcl owner/name', 2)

  const forgeSsh = setting(readUserConfig('config'), 'forgeSsh')
  const forge = configuredForge()?.url ?? (forgeSsh === undefined ? undefined : SSH_HOST.exec(forgeSsh)?.[1])
  const url = urlOf(repo, forge)
  const isOwnerName = OWNER_NAME.test(repo) && !repo.startsWith('.')
  const sshUrl = isOwnerName && forge !== undefined ? sshUrlOf(repo, forgeSsh ?? `git@${SCHEME.test(forge) ? new URL(forge).hostname : forge}`) : undefined
  const name = nameOf(url)

  if (name === '')
    fail(`no folder name can be taken from ${url}, give one: gcl ${repo} <dir>`, 2)

  const target: Target = { repo, url, sshUrl, forgeSsh, path: resolve(given ?? name) }
  const { path } = target
  const outcome = existsSync(path) && (!statSync(path).isDirectory() || readdirSync(path).length > 0) ? 'existing' : 'cloned'
  const prompts = askpass()
  const env = { ...process.env, ...prompts.env }
  let from: string

  try {
    from = outcome === 'existing' ? await update(target, env) : await clone(target, env)
  }
  finally {
    prompts.close()
  }

  const { status, head } = await repoState(path)
  const result = { url: from, path, branch: status?.branch ?? null, head: head?.sha ?? null, outcome }

  if (values.json === true)
    printJson(result)
  else
    console.log(path)

  if (values.json !== true)
    console.error(`${outcome === 'cloned' ? 'cloned' : 'already cloned'} ${from}${result.branch === null ? '' : ` on ${result.branch}`}${result.head === null ? '' : ` at ${result.head}`}`)

  return 0
}

if (import.meta.main)
  process.exitCode = await runMain({ name: 'gcl', run: main })
