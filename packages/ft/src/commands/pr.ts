import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { badge, badUsage, fail, formatAge, hyperlink, jsonOption, limitOf, limitOptions, openUrl, paint, parse, printJson, role, runHint, table, truncate, wholeNumber } from '@kaynooo/cli-kit'
import { openOption, repoOption } from '../args'
import { git } from '../git'
import { good } from '../good'
import { createPull, getPull, listPulls, mergePull, pullComments, pullDiff, pullFetchRef } from '../pulls'
import { repoDefaultBranch } from '../tea'
import { noteText } from './issue-target'

const TITLE_WIDTH = 72
const DEFAULT_LIMIT = 30
const LEADING_HASH = /^#/

const prUsage = `ft pr <list|view|create|checkout|merge> [args...]

Manage pull requests (Forgejo, GitHub) and merge requests (GitLab).

  ft pr list [--state open|closed|all] [--base <branch>] [--author <user>] [--json]
  ft pr view <n> [-c] [--diff] [--open] [--json]
  ft pr create [-t <title>] [-b <body> | -F <file>] [--base <branch>] [--head <branch>] [--draft] [--json]
  ft pr checkout <n>
  ft pr merge <n> [--squash | --rebase | --merge] [--delete-branch] [--json]`

const PR_EXITS: ExitRow[] = [[0, 'completed'], [1, 'forge or git failed'], [2, 'a usage error']]

async function prList(args: string[]): Promise<number> {
  const { values } = parse(args, 'ft pr list [--state open|closed|all] [--base <branch>] [--author <user>] [--limit <n>] [--json]', {
    state: { type: 'string', choices: ['open', 'closed', 'all'], description: 'filter by PR/MR state (default: open)' },
    base: { type: 'string', short: 'B', description: 'only targeting this base branch' },
    author: { type: 'string', short: 'a', description: 'only opened by this user' },
    ...limitOptions(DEFAULT_LIMIT),
    json: jsonOption('array of {number, title, state, draft, author, head, base, url, created_at, updated_at}'),
    ...repoOption,
  }, { exits: PR_EXITS })

  const state = values.state ?? 'open'
  const limit = limitOf(values, DEFAULT_LIMIT)
  const pulls = await listPulls({ state, base: values.base, author: values.author, limit, repo: values.repo })

  if (values.json === true) {
    printJson(pulls.map(pr => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      author: pr.author,
      head: pr.head,
      base: pr.base,
      url: pr.html_url,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
    })))

    return 0
  }

  if (pulls.length === 0) {
    console.log('no pull request')

    return 0
  }

  const dim = paint(process.stdout).dim
  const id = role('id', process.stdout)

  console.log(table([
    ['#', 'STATE', 'BRANCH', 'AUTHOR', 'AGE', 'TITLE'],
    ...pulls.map(pr => [
      hyperlink(id(`#${pr.number}`), pr.html_url, process.stdout),
      badge(pr.draft ? 'draft' : pr.state, process.stdout),
      `${pr.head} -> ${pr.base}`,
      pr.author,
      pr.created_at === '' ? '-' : dim(formatAge(pr.created_at)),
      truncate(pr.title, TITLE_WIDTH),
    ]),
  ], { header: true }))

  return 0
}

async function prView(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, 'ft pr view <n> [-c] [--diff] [--open] [--json]', {
    comments: { type: 'boolean', short: 'c', description: 'include comments' },
    diff: { type: 'boolean', short: 'd', description: 'print the unified diff' },
    json: jsonOption('{number, title, state, draft, author, head, base, body, url, comments, diff?}'),
    ...openOption,
    ...repoOption,
  }, { positionals: ['<n>'], exits: PR_EXITS })

  const number = wholeNumber((positionals[0] ?? '').replace(LEADING_HASH, ''), '<n>', 1)
  const pr = await getPull(number, values.repo)
  const comments = values.comments === true || values.json === true ? await pullComments(number, values.repo) : []
  const diff = values.diff === true ? await pullDiff(number, values.repo) : undefined

  if (values.open === true)
    openUrl(pr.html_url)

  if (values.json === true) {
    printJson({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      author: pr.author,
      head: pr.head,
      base: pr.base,
      body: pr.body,
      url: pr.html_url,
      comments: comments.map(each => ({ author: each.user.login, at: each.created_at, body: each.body })),
      ...diff === undefined ? {} : { diff },
    })

    return 0
  }

  const label = pr.draft ? `${pr.state}, draft` : pr.state
  const parts = [`#${pr.number} ${pr.title} (${label}, ${pr.head} -> ${pr.base} by ${pr.author})\n${pr.html_url}`]

  if (pr.body.trim() !== '')
    parts.push(pr.body.trim())

  if (values.comments === true) {
    for (const each of comments)
      parts.push(`--- ${each.user.login}, ${formatAge(each.created_at)}\n${each.body.replaceAll('\r\n', '\n').trim()}`)
  }

  if (diff !== undefined)
    parts.push(diff)

  console.log(parts.join('\n\n'))

  return 0
}

async function prCreate(args: string[]): Promise<number> {
  const { values } = parse(args, 'ft pr create [-t <title>] [-b <body> | -F <file>] [--base <branch>] [--head <branch>] [--draft] [--json]', {
    title: { type: 'string', short: 't', description: 'PR/MR title (defaults to latest commit subject)' },
    body: { type: 'string', short: 'b', description: 'PR/MR description' },
    file: { type: 'string', short: 'F', description: 'read description from a file, or - for stdin' },
    base: { type: 'string', short: 'B', description: 'target branch (defaults to repository default branch)' },
    head: { type: 'string', short: 'H', description: 'source branch (defaults to current git branch)' },
    draft: { type: 'boolean', short: 'd', description: 'open as a draft/WIP pull request' },
    json: jsonOption('{number, title, state, draft, head, base, url}'),
    ...repoOption,
  }, { exits: PR_EXITS })

  const head = values.head ?? await git(['branch', '--show-current'])

  if (head === '')
    fail('cannot determine source branch from a detached HEAD: pass --head <branch>', 2)

  const base = values.base ?? await repoDefaultBranch(values.repo)

  if (head === base)
    fail(`source branch and base branch are both '${head}': switch to a feature branch or pass --head/--base`, 2)

  const givenTitle = values.title?.trim()
  const title = givenTitle !== undefined && givenTitle !== '' ? givenTitle : await git(['log', '-1', '--format=%s'])

  if (title === '')
    fail('a title is needed: pass -t <title>', 2)

  const body = await noteText({ message: values.body, file: values.file }) ?? ''
  const created = await createPull({ title, body, head, base, draft: values.draft === true, repo: values.repo })

  if (values.json === true)
    printJson({ number: created.number, title: created.title, state: created.state, draft: created.draft, head: created.head, base: created.base, url: created.html_url })
  else
    console.log(good(`opened #${created.number} (${created.head} -> ${created.base}): ${created.html_url}`))

  return 0
}

async function prCheckout(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, 'ft pr checkout <n> [--branch <name>]', {
    branch: { type: 'string', short: 'b', description: 'local branch name to create/update (default: pr-<n>)' },
    ...repoOption,
  }, { positionals: ['<n>'], exits: PR_EXITS })

  const number = wholeNumber((positionals[0] ?? '').replace(LEADING_HASH, ''), '<n>', 1)
  const ref = await pullFetchRef(number, values.repo)
  const localBranch = values.branch ?? `pr-${number}`

  await git(['fetch', 'origin', `${ref}:refs/heads/${localBranch}`])
  await git(['switch', localBranch])
  console.log(good(`checked out #${number} on ${localBranch}`))

  return 0
}

async function prMerge(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, 'ft pr merge <n> [--squash | --rebase | --merge] [--delete-branch] [--json]', {
    'squash': { type: 'boolean', short: 's', description: 'squash commits when merging' },
    'rebase': { type: 'boolean', description: 'rebase commits onto base' },
    'merge': { type: 'boolean', short: 'm', description: 'create a merge commit (default)' },
    'delete-branch': { type: 'boolean', short: 'd', description: 'delete the source branch after merging' },
    'json': jsonOption('{number, merged: true, method, deletedBranch}'),
    ...repoOption,
  }, { positionals: ['<n>'], exits: PR_EXITS })

  const chosen = [values.squash === true ? 'squash' : undefined, values.rebase === true ? 'rebase' : undefined, values.merge === true ? 'merge' : undefined].filter((each): each is 'squash' | 'rebase' | 'merge' => each !== undefined)

  if (chosen.length > 1)
    badUsage('pass at most one of --merge, --squash or --rebase')

  const method = chosen[0] ?? 'merge'
  const number = wholeNumber((positionals[0] ?? '').replace(LEADING_HASH, ''), '<n>', 1)

  await mergePull(number, { method, deleteBranch: values['delete-branch'] === true, repo: values.repo })

  if (values.json === true)
    printJson({ number, merged: true, method, deletedBranch: values['delete-branch'] === true })
  else
    console.log(good(`merged #${number} (${method})`))

  return 0
}

export async function pr(args: string[]): Promise<number> {
  const [sub, ...rest] = args

  if (sub === undefined || sub === '-h' || sub === '--help') {
    parse(sub === undefined ? ['--help'] : args, prUsage, {}, { exits: PR_EXITS })

    return 0
  }

  if (sub === 'list' || sub === 'ls')
    return prList(rest)

  if (sub === 'view' || sub === 'show')
    return prView(rest)

  if (sub === 'create' || sub === 'new')
    return prCreate(rest)

  if (sub === 'checkout' || sub === 'co')
    return prCheckout(rest)

  if (sub === 'merge')
    return prMerge(rest)

  fail(`unknown pr subcommand '${sub}': expected list, view, create, checkout or merge`, 2, runHint('ft pr --help'))
}
