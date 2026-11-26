import type { ExitRow } from '@kaynooo/cli-kit'
import { relative } from 'node:path'
import process from 'node:process'
import { configuredNumber, fail, jsonOption, marked, parse, pool, printJson, role, runCommand, wholeNumber } from '@kaynooo/cli-kit'
import { progressLine } from '@kaynooo/cli-kit/progress'
import { CONCURRENCY, fastForward, fastForwardDirty, findRepos, inspect, pullBlocker, pushRepo, REASONS, reasonsOf, skipped } from './repos-scan'
import { baseOf, rootsOf, scanRoots } from './roots'

const PULL_USAGE = `ws pull [options] [root...]: fetch and fast-forward every repository under each root (configured workspace by default)

Clean repositories behind their upstream are fast-forwarded; with --dirty, dirty repositories that are only behind are safely stashed, fast-forwarded, and popped.
--prune deletes stale remote-tracking branches while fetching.`

const PULL_EXITS: ExitRow[] = [[0, 'pulled or up to date'], [1, 'a fast-forward or stash pop failed'], [2, 'a usage error or a root that is no folder']]

const PULL_OPTIONS = {
  'prune': { type: 'boolean', short: 'p', description: 'pass --prune to git fetch' },
  'dirty': { type: 'boolean', description: 'also fast-forward dirty behind repos via temporary stash/pop' },
  'dry-run': { type: 'boolean', description: 'fetch and show what would be pulled without changing branches' },
  'json': jsonOption('[{repo, path, action (pulled|skipped|failed|up-to-date), detail}]'),
} as const

export async function pull(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, PULL_USAGE, PULL_OPTIONS, { positionals: ['[root...]'], exits: PULL_EXITS })
  const roots = rootsOf(positionals)
  const base = baseOf(roots)

  const progress = progressLine()
  let states

  try {
    progress.update({ step: 'finding the repositories' })
    const paths = await scanRoots(roots, async root => findRepos(root, await skipped()))

    progress.update({ step: 'fetching', done: 0, total: paths.length, unit: 'repositories' })
    states = await pool(paths, configuredNumber('repos', 'concurrency', CONCURRENCY), async path => inspect(path, true, values.prune === true), (done, total) => progress.update({ step: 'fetching', done, total, unit: 'repositories' }))
  }
  finally {
    progress.stop()
  }

  const results: { repo: string, path: string, action: 'pulled' | 'skipped' | 'failed' | 'up-to-date', detail: string }[] = []
  let failed = 0

  for (const repo of states) {
    const shown = relative(base, repo.path) || repo.name

    if ((repo.behind ?? 0) === 0 && !repo.fetchFailed && !repo.unreadable) {
      results.push({ repo: shown, path: repo.path, action: 'up-to-date', detail: '' })

      continue
    }

    const blocker = pullBlocker(repo)
    const dirtyOnly = values.dirty === true && repo.dirty > 0 && !repo.unreadable && !repo.fetchFailed && repo.branch !== '(detached)' && repo.upstream !== null && (repo.ahead ?? 0) === 0

    if (blocker !== undefined && !dirtyOnly) {
      results.push({ repo: shown, path: repo.path, action: 'skipped', detail: blocker })

      if (values.json !== true)
        console.log(marked('note', `${shown} skipped`, process.stdout, blocker))

      continue
    }

    if (values['dry-run'] === true) {
      const detail = `${repo.behind} ${repo.behind === 1 ? 'commit' : 'commits'}${dirtyOnly ? ' (with autostash)' : ''}`

      results.push({ repo: shown, path: repo.path, action: 'pulled', detail: `would pull ${detail}` })

      if (values.json !== true)
        console.log(marked('note', `${shown} would pull`, process.stdout, detail))

      continue
    }

    const err = dirtyOnly ? await fastForwardDirty(repo.path) : await fastForward(repo.path)

    if (err !== undefined) {
      failed++
      results.push({ repo: shown, path: repo.path, action: 'failed', detail: err })

      if (values.json !== true)
        console.log(marked('problem', `${shown} not pulled`, process.stdout, err))
    }
    else {
      const detail = `${repo.behind} ${repo.behind === 1 ? 'commit' : 'commits'}${dirtyOnly ? ' (autostashed)' : ''}`

      results.push({ repo: shown, path: repo.path, action: 'pulled', detail })

      if (values.json !== true)
        console.log(marked('ok', `${shown} pulled`, process.stdout, detail))
    }
  }

  if (values.json === true) {
    printJson(results)
  }
  else if (results.every(each => each.action === 'up-to-date')) {
    console.log(role('label', process.stdout)(`all ${states.length} repositories up to date`))
  }

  return failed > 0 ? 1 : 0
}

const PUSH_USAGE = `ws push [options] [root...]: push every repository under each root (configured workspace by default) that is ahead of its upstream and not behind`

const PUSH_EXITS: ExitRow[] = [[0, 'pushed or nothing ahead'], [1, 'a push failed'], [2, 'a usage error or a root that is no folder']]

const PUSH_OPTIONS = {
  'dry-run': { type: 'boolean', description: 'list the repositories that would be pushed without pushing' },
  'json': jsonOption('[{repo, path, action (pushed|skipped|failed), detail}]'),
} as const

export async function push(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, PUSH_USAGE, PUSH_OPTIONS, { positionals: ['[root...]'], exits: PUSH_EXITS })
  const roots = rootsOf(positionals)
  const base = baseOf(roots)

  const paths = await scanRoots(roots, async root => findRepos(root, await skipped()))
  const states = await pool(paths, configuredNumber('repos', 'concurrency', CONCURRENCY), async path => inspect(path, false))
  const aheadRepos = states.filter(repo => (repo.ahead ?? 0) > 0)
  const results: { repo: string, path: string, action: 'pushed' | 'skipped' | 'failed', detail: string }[] = []
  let failed = 0

  for (const repo of aheadRepos) {
    const shown = relative(base, repo.path) || repo.name

    if (repo.branch === '(detached)' || repo.upstream === null) {
      results.push({ repo: shown, path: repo.path, action: 'skipped', detail: 'no upstream or detached' })

      continue
    }

    if ((repo.behind ?? 0) > 0) {
      results.push({ repo: shown, path: repo.path, action: 'skipped', detail: `diverged (${repo.behind} behind)` })

      if (values.json !== true)
        console.log(marked('note', `${shown} skipped`, process.stdout, `diverged (${repo.behind} behind)`))

      continue
    }

    if (values['dry-run'] === true) {
      const detail = `${repo.ahead} ${repo.ahead === 1 ? 'commit' : 'commits'} to ${repo.upstream}`

      results.push({ repo: shown, path: repo.path, action: 'pushed', detail: `would push ${detail}` })

      if (values.json !== true)
        console.log(marked('note', `${shown} would push`, process.stdout, detail))

      continue
    }

    const err = await pushRepo(repo.path)

    if (err !== undefined) {
      failed++
      results.push({ repo: shown, path: repo.path, action: 'failed', detail: err })

      if (values.json !== true)
        console.log(marked('problem', `${shown} push failed`, process.stdout, err))
    }
    else {
      const detail = `${repo.ahead} ${repo.ahead === 1 ? 'commit' : 'commits'}`

      results.push({ repo: shown, path: repo.path, action: 'pushed', detail })

      if (values.json !== true)
        console.log(marked('ok', `${shown} pushed`, process.stdout, detail))
    }
  }

  if (values.json === true)
    printJson(results)
  else if (aheadRepos.length === 0)
    console.log(role('label', process.stdout)(`nothing ahead in ${states.length} repositories`))

  return failed > 0 ? 1 : 0
}

const EXEC_USAGE = `ws exec [options] [root...] -- <cmd...>: run a command across every repository under each root (configured workspace by default)`

const EXEC_EXITS: ExitRow[] = [[0, 'command exited 0 in every repository'], [1, 'command exited non-zero in one or more repositories'], [2, 'a usage error or a root that is no folder']]

const EXEC_OPTIONS = {
  only: { type: 'string', multiple: true, choices: REASONS, description: 'only repositories matching this reason (dirty, unpushed, unreleased, behind)' },
  parallel: { type: 'string', short: 'j', description: 'how many repositories to run in parallel (4)' },
  json: jsonOption('[{repo, path, code, stdout, stderr}]'),
} as const

export async function exec(args: string[]): Promise<number> {
  const sep = args.indexOf('--')
  const ownArgs = sep === -1 ? args : args.slice(0, sep)
  const cmd = sep === -1 ? [] : args.slice(sep + 1)
  const { values, positionals } = parse(ownArgs, EXEC_USAGE, EXEC_OPTIONS, { positionals: ['[root...]'], exits: EXEC_EXITS })

  if (cmd.length === 0)
    fail(`a command is needed after --\n\n${EXEC_USAGE}`, 2)

  const roots = rootsOf(positionals)
  const base = baseOf(roots)

  const concurrency = wholeNumber(values.parallel, 'parallel', 4, 1)
  const only = values.only ?? []
  let paths = await scanRoots(roots, async root => findRepos(root, await skipped()))

  if (only.length > 0) {
    const states = await pool(paths, configuredNumber('repos', 'concurrency', CONCURRENCY), async path => inspect(path, false))

    paths = states.filter(repo => reasonsOf(repo).some(reason => only.includes(reason))).map(repo => repo.path)
  }

  const results = await pool(paths, concurrency, async (path) => {
    const ran = await runCommand(cmd, { cwd: path })

    return { repo: relative(base, path) || path, path, code: ran.code, stdout: ran.stdout, output: ran.text }
  })

  if (values.json === true) {
    printJson(results)
  }
  else {
    const label = role('path', process.stdout)

    for (const res of results) {
      const status = res.code === 0 ? role('ok', process.stdout)('ok') : role('problem', process.stdout)(`exit ${res.code}`)

      console.log(`${label(res.repo)} ${status}`)

      if (res.output.trim() !== '')
        console.log(res.output.trimEnd())
    }
  }

  return results.some(res => res.code !== 0) ? 1 : 0
}
