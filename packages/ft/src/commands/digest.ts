import type { ExitRow, Session } from '@kaynooo/cli-kit'
import type { Claim } from '../claims'
import type { Issue } from '../issues'
import type { Run } from '../runs'
import process from 'node:process'
import { badge, currentSession, formatAge, jsonOption, liveSessions, paint, parse, printJson, role, runCommand, section, table, truncate, upTo, watching, watchOption, withoutWatch } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { boxes } from '../checklist'
import { latestClaim } from '../claims'
import { defaultBranch, git, gitOk } from '../git'
import { commentsOfAll, openIssues, sessionAuthor } from '../issues'
import { FINISHED, newestPerWorkflow, recentRuns } from '../runs'
import { standing } from './board'

const RUNS_SCANNED = 50
const TITLE_WIDTH = 70
const SHOWN = 8
const LINE_START = /^/gm

export interface ClaimedIssue { number: number, title: string, holder: string, since: string, boxesLeft: number, boxesTotal: number }
export interface DigestRun { id: number, status: string, workflow: string, started: string, title: string }
export interface DirtyFile { status: string, path: string }
export interface StaleTodo { issue: string, comments: { path: string, line: number }[] }

export interface Digest {
  held: ClaimedIssue[]
  away: ClaimedIssue[]
  ci: DigestRun[]
  unpushed: string[]
  dirty: DirtyFile[]
  stale: StaleTodo[]
}

function claimed(issue: Issue, claim: Claim): ClaimedIssue {
  const list = boxes(issue.body)

  return { number: issue.number, title: issue.title, holder: claim.holder, since: claim.at, boxesLeft: list.filter(box => !box.done).length, boxesTotal: list.length }
}

// The issues this session or its lanes hold, and those claimed by a session no session here answers to.
export function claims(rows: { issue: Issue, claim: Claim | undefined }[], sessions: Session[], me: Session | undefined): Pick<Digest, 'held' | 'away'> {
  const held: ClaimedIssue[] = []
  const away: ClaimedIssue[] = []

  for (const { issue, claim } of rows) {
    const row = standing(claim, sessions)

    if (row.state === 'taken' && me !== undefined && row.session.pid === me.pid)
      held.push(claimed(issue, row.claim))
    else if (row.state === 'away')
      away.push(claimed(issue, row.claim))
  }

  return { held, away }
}

// The newest push run of each workflow on the branch that is red or not finished.
export function unsettled(runs: Run[], branch: string): DigestRun[] {
  return newestPerWorkflow(runs.filter(run => run.prettyref === branch))
    .filter(run => run.status === 'failure' || !FINISHED.has(run.status))
    .map(run => ({ id: run.id, status: run.status, workflow: run.workflow_id, started: run.started, title: run.title }))
}

export function dirtyFiles(porcelain: string): DirtyFile[] {
  return porcelain.split('\n').flatMap((line) => {
    const trimmed = line.trim()
    const space = trimmed.indexOf(' ')

    return space === -1 ? [] : [{ status: trimmed.slice(0, space), path: trimmed.slice(space + 1).trim() }]
  })
}

// Commits HEAD has beyond its upstream, or beyond origin's default branch when it tracks nothing; none when git cannot tell.
async function unpushedCommits(): Promise<string[]> {
  const base = await gitOk(['rev-parse', '--verify', '-q', '@{upstream}']) ? '@{upstream}' : `origin/${await defaultBranch()}`

  if (!await gitOk(['rev-parse', '--verify', '-q', base]))
    return []

  return (await git(['log', `${base}..HEAD`, '--format=%h %s'])).split('\n').filter(Boolean)
}

async function dirtyTree(): Promise<DirtyFile[]> {
  return dirtyFiles(await git(['status', '--porcelain']))
}

// Run apart so a repository git cannot read just leaves the section out.
async function quietly<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read()
  }
  catch {
    return []
  }
}

interface ScannedTodo { path: string, line: number, refs: { repo: string, number: number, state?: string }[] }

// The comments naming a closed issue, by issue; left out quietly when `src todo-scan` is not installed or fails.
export async function staleTodos(): Promise<StaleTodo[]> {
  const bin = Bun.which('src', { PATH: process.env.PATH ?? '' })

  if (bin === null)
    return []

  let found: ScannedTodo[]

  try {
    const ran = await runCommand([bin, 'todo-scan', '--stale', '--json'])

    found = JSON.parse(ran.stdout) as ScannedTodo[]
  }
  catch {
    return []
  }

  const byIssue = new Map<string, StaleTodo>()

  for (const mark of found) {
    for (const ref of mark.refs.filter(each => each.state === 'closed')) {
      const key = `${ref.repo}#${ref.number}`
      const entry = byIssue.get(key) ?? { issue: key, comments: [] }

      entry.comments.push({ path: mark.path, line: mark.line })
      byIssue.set(key, entry)
    }
  }

  return [...byIssue.values()]
}

function claimLine(row: ClaimedIssue, now: number): string[] {
  const id = role('id', process.stdout)

  return [id(`#${row.number}`), row.holder, paint(process.stdout).dim(formatAge(row.since, now)), row.boxesTotal === 0 ? '' : `${row.boxesLeft}/${row.boxesTotal} left`, truncate(row.title, TITLE_WIDTH)]
}

function capped(lines: string[]): string[] {
  return lines.length > SHOWN ? [...lines.slice(0, SHOWN), `... ${lines.length - SHOWN} more`] : lines
}

export function renderDigest(digest: Digest, now = Date.now()): string {
  const sections = [
    { heading: 'held by this session', tone: 'running' as const, count: digest.held.length, lines: table(digest.held.map(row => claimLine(row, now))).split('\n') },
    { heading: 'claimed, no live session here', tone: 'warn' as const, count: digest.away.length, lines: table(digest.away.map(row => claimLine(row, now))).split('\n') },
    { heading: 'CI on the default branch', tone: 'failed' as const, count: digest.ci.length, lines: digest.ci.map(run => `${run.workflow} ${badge(run.status, process.stdout)} (run ${run.id}) ${truncate(upTo(run.title, '\n'), TITLE_WIDTH)}`) },
    { heading: 'unpushed commits', tone: 'queued' as const, count: digest.unpushed.length, lines: capped(digest.unpushed) },
    { heading: 'dirty files', tone: 'warn' as const, count: digest.dirty.length, lines: capped(digest.dirty.map(file => `${file.status} ${role('path', process.stdout)(file.path)}`)) },
    { heading: 'stale TODO comments', tone: 'skipped' as const, count: digest.stale.length, lines: capped(digest.stale.map(todo => `${todo.issue} closed: ${todo.comments.map(each => `${each.path}:${each.line}`).join(', ')}`)) },
  ].filter(each => each.count > 0)

  return sections.length === 0 ? 'nothing to pick up' : sections.map(({ heading, tone, count, lines }) => `${section(heading, count, process.stdout, process.env, tone)}\n${lines.join('\n').replace(LINE_START, '  ')}`).join('\n\n')
}

const usage = `ft digest

Summarises the repository for a session starting cold: the issues this session holds with their boxes left, the claims no live session here answers to, red or running CI on the default branch, unpushed commits, dirty files and TODO comments naming a closed issue.
A section with nothing in it is left out, and the stale TODO comments need todo-scan on the PATH.`
const EXITS: ExitRow[] = [[0, 'it summarised the repository'], [1, 'Forgejo cannot be read'], [2, 'a usage error']]

const options = {
  json: jsonOption('held and away (number, title, holder, since, boxesLeft, boxesTotal), ci (id, status, workflow, started, title), unpushed, dirty (status, path) and stale (issue, comments: path, line)'),
  watch: watchOption('the digest'),
  ...repoOption,
} as const

export async function digest(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { exits: EXITS })

  const { values } = parsed

  if (values.watch !== undefined)
    return watching(values.watch, async () => digest(withoutWatch(args)))

  const [issues, sessions, branch, runs] = await Promise.all([openIssues(undefined, values.repo), liveSessions(), defaultBranch(), recentRuns(RUNS_SCANNED, values.repo)])
  const comments = await commentsOfAll(issues, values.repo)
  const me = await currentSession(sessions)
  const author = await sessionAuthor()
  const rows = issues.map(issue => ({ issue, claim: latestClaim(comments.get(issue.number) ?? [], author) }))
  const [unpushed, dirty, stale] = await Promise.all([quietly(unpushedCommits), quietly(dirtyTree), staleTodos()])
  const summary: Digest = { ...claims(rows, sessions, me), ci: unsettled(runs, branch), unpushed, dirty, stale }

  if (values.json === true) {
    printJson(summary)
  }
  else {
    console.log(renderDigest(summary))
  }

  return 0
}
