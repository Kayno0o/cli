import type { Session } from '@kaynooo/cli-kit'
import type { Claim } from '../claims'
import type { Issue, IssueComment } from '../issues'
import { badUsage, capped, currentSession, Exit, fail, formatAge, jsonOption, limitOf, limitOptions, link, liveSessions, paint, parse, printHint, printJson, role, runHint, table, takesControlCodes, truncate, watching, watchOption, withoutWatch } from '@kaynooo/cli-kit'
import { issueNumbers, repoOption } from '../args'
import { boxes } from '../checklist'
import { holderSession, laneSuffix, latestClaim, latestNote, releasedComment, takenComment } from '../claims'
import { comment, commentsOf, commentsOfAll, getIssue, openIssues, sessionAuthor } from '../issues'
import { findMilestone } from '../milestones'

const LINE_START = /^/gm
const TITLE_WIDTH = 80

export type Standing = { state: 'available' } | { state: 'taken', claim: Claim, session: Session } | { state: 'away', claim: Claim }

// A claim whose holder runs on this machine is taken; one no session here answers to may be a session on another machine, so it is only reported.
export function standing(claim: Claim | undefined, sessions: Session[]): Standing {
  if (claim === undefined)
    return { state: 'available' }

  const session = holderSession(claim.holder, sessions)

  return session === undefined ? { state: 'away', claim } : { state: 'taken', claim, session }
}

const NOTE_WIDTH = 100
const STATES = new Set(['available', 'taken', 'away'])

type Claimed = Exclude<Standing, { state: 'available' }>

export interface BoardRow { issue: Issue, standing: Standing, comments: IssueComment[] }

// Dims text, and leaves an empty cell empty so the table can still trim the line.
function dimmed(text: string): string {
  return text === '' ? '' : paint(process.stdout).dim(text)
}

// `#12` in the id colour, a link to the issue on a terminal that draws links; plain elsewhere, where a url beside every number would swell the table.
function issueNumber(issue: Issue): string {
  const number = role('id', process.stdout)(`#${issue.number}`)

  return takesControlCodes(process.stdout) ? link(number, issue.html_url, process.stdout) : number
}

function boxesLeft(issue: Issue): string {
  const list = boxes(issue.body)

  return list.length === 0 ? '' : `${list.filter(box => !box.done).length}/${list.length} left`
}

function claimRow(issue: Issue, row: Claimed, now: number): string[] {
  const holder = row.state === 'taken' && row.session.name !== row.claim.holder ? `${row.claim.holder} via ${row.session.name}` : row.claim.holder
  const status = row.state === 'taken' ? ` (${row.session.status})` : ''

  return [issueNumber(issue), `${holder}${status}`, paint(process.stdout).dim(formatAge(row.claim.at, now)), boxesLeft(issue), truncate(issue.title, TITLE_WIDTH)]
}

// The first line of the latest comment that is not a claim, which tells whether a claim no live session holds landed in part.
function noteLine(comments: IssueComment[], now: number): string[] {
  const note = latestNote(comments)
  const first = note?.body.split('\n').map(line => line.trim()).find(line => line !== '')

  return note === undefined || first === undefined ? [] : [`    ${note.user.login} ${formatAge(note.created_at, now)}: ${truncate(first, NOTE_WIDTH)}`]
}

// A section's table of at most `limit` rows, the count of the rest on a last line, each line mapped through `decorate`.
function within<T>(rows: T[], limit: number, cells: (row: T) => string[], decorate: (line: string, index: number) => string[] = line => [line]): { lines: string[] } {
  const { shown, footer } = capped(rows, limit)

  return { lines: [...table(shown.map(cells)).split('\n').flatMap(decorate), ...footer === undefined ? [] : [footer]] }
}

// Each section lists at most `limit` issues and ends on the count of the rest.
export function renderBoard(rows: BoardRow[], now = Date.now(), limit = Number.POSITIVE_INFINITY): string {
  const available = rows.filter(row => row.standing.state === 'available')
  const claimed = (state: Claimed['state']) => rows.flatMap(({ issue, standing: row, comments }) => row.state === state ? [{ issue, row, comments }] : [])
  const taken = claimed('taken')
  const away = claimed('away')
  const sections = [
    { heading: 'available', count: available.length, ...within(available, limit, ({ issue }) => [issueNumber(issue), truncate(issue.title, TITLE_WIDTH), dimmed(issue.labels.map(label => label.name).join(', '))]) },
    { heading: 'taken', count: taken.length, ...within(taken, limit, ({ issue, row }) => claimRow(issue, row, now)) },
    { heading: 'claimed, no live session here', count: away.length, ...within(away, limit, ({ issue, row }) => claimRow(issue, row, now), (line, index) => [line, ...noteLine(away[index]?.comments ?? [], now)]) },
  ].filter(section => section.count > 0)

  return sections.length === 0 ? 'no open issue' : sections.map(({ heading, count, lines }) => `${paint(process.stdout).bold(`${heading} (${count})`)}\n${lines.join('\n').replace(LINE_START, '  ')}`).join('\n\n')
}

// Each issue with the standing its latest claim gives it among the sessions running here.
export async function boardRows(issues: Issue[], sessions: Session[], repo: string | undefined): Promise<BoardRow[]> {
  const comments = await commentsOfAll(issues, repo)
  const author = await sessionAuthor()

  return issues.map((issue) => {
    const own = comments.get(issue.number) ?? []

    return { issue, standing: standing(latestClaim(own, author), sessions), comments: own }
  })
}

// The open issues whose standing claim answers to this session, its lanes included.
export function heldBy(rows: BoardRow[], session: Session): number[] {
  return rows.flatMap(({ issue, standing: now }) => now.state === 'taken' && now.session.pid === session.pid ? [issue.number] : [])
}

// The issues this session holds, none when it is not run from a Claude Code session.
export async function heldIssues(repo: string | undefined): Promise<number[]> {
  const sessions = await liveSessions()
  const session = await currentSession(sessions)

  return session === undefined ? [] : heldBy(await boardRows(await openIssues(undefined, repo), sessions, repo), session)
}

export function boardJson(rows: BoardRow[]) {
  return rows.map(({ issue, standing: { state, ...rest }, comments: own }) => {
    const list = boxes(issue.body)
    const note = latestNote(own)

    return {
      number: issue.number,
      title: issue.title,
      labels: issue.labels.map(label => label.name),
      state,
      holder: 'claim' in rest ? rest.claim.holder : undefined,
      since: 'claim' in rest ? rest.claim.at : undefined,
      session: 'session' in rest ? rest.session.name : undefined,
      boxesTotal: list.length,
      boxesLeft: list.filter(box => !box.done).length,
      note: note === undefined ? undefined : { author: note.user.login, at: note.created_at, body: note.body },
    }
  })
}

const boardUsage = `ft board

Lists open issues, at most 30 of each kind (--full for all), as available, taken by a session running here, or claimed by a session no session here answers to, from their latest "Taken by session <name>." comment.
A claim shows its boxes left, and one no live session holds also the latest comment that is not a claim.
A lane's claim (lane-<n>-<issue>) is held while the session whose name ends in -<n> runs.

Exits 0 when it listed them, 1 when the issues cannot be read, 2 on a usage error.`

const BOARD_LIMIT = 30

const boardOptions = {
  labels: { type: 'string', short: 'L', description: 'only issues with these labels, comma separated' },
  milestone: { type: 'string', short: 'm', description: 'only issues of this milestone, a title or an id' },
  query: { type: 'string', short: 'q', description: 'only issues whose title matches this, a case-insensitive regex such as dom|eager' },
  state: { type: 'string', description: 'only issues in this state: available, taken or away (claimed, no live session here)' },
  ...limitOptions(BOARD_LIMIT),
  json: jsonOption('number, title, labels, state, holder, since, session, boxesTotal, boxesLeft and note (author, at, body of the latest comment that is not a claim)'),
  watch: watchOption('the board'),
  ...repoOption,
} as const

export async function board(args: string[]): Promise<number> {
  const parsed = parse(args, boardUsage, boardOptions)

  const { values } = parsed

  if (values.watch !== undefined)
    return watching(values.watch, async () => board(withoutWatch(args)))

  const state = values.state
  const limit = limitOf(values, BOARD_LIMIT)

  if (state !== undefined && !STATES.has(state))
    fail(`--state takes available, taken or away, not ${state}`)

  let query: RegExp | undefined

  try {
    query = values.query === undefined ? undefined : new RegExp(values.query, 'i')
  }
  catch (error) {
    fail(`--query: ${error instanceof Error ? error.message : String(error)}`)
  }

  const milestone = values.milestone === undefined ? undefined : (await findMilestone(values.milestone, values.repo)).id
  const [open, sessions] = await Promise.all([openIssues(values.labels, values.repo, milestone), liveSessions()])
  const issues = query === undefined ? open : open.filter(issue => query.test(issue.title))
  const rows = (await boardRows(issues, sessions, values.repo)).filter(row => state === undefined || row.standing.state === state)

  if (values.json === true) {
    printJson(boardJson(rows.slice(0, limit)))

    return 0
  }

  console.log(rows.length === 0 && (query !== undefined || state !== undefined) ? 'no open issue matches' : renderBoard(rows, Date.now(), limit))

  return 0
}

async function me(as: string | undefined, sessions: Session[]): Promise<string> {
  if (as !== undefined)
    return as

  const session = await currentSession(sessions)

  if (session === undefined)
    fail('not run from a Claude Code session: pass --as <name>')

  return session.name
}

const takeUsage = `ft take <n>...

Claims each issue for this Claude Code session with a "Taken by session <name>." comment.
An issue another live session holds is refused, one this session or its lanes hold passes to the new name, and one claimed by a session no session here answers to needs --take-stale; a refusal leaves the other issues taken.

Exits 0 when every issue is taken, 1 when one is refused, 2 on a usage error.`

const laneOption = {
  lane: { type: 'boolean', description: 'claim each as lane-<s>-<n>, <s> ending this session\'s name, so the claim stays live while it runs' },
} as const

const takeOptions = {
  'as': { type: 'string', description: 'the name to claim as, instead of this session\'s' },
  ...laneOption,
  'take-stale': { type: 'boolean', description: 'take it over from a claim no live session here answers to' },
  ...repoOption,
} as const

// The name each issue is claimed as: the session's own, or with --lane the lane named after it and the issue.
async function claimant(values: { as?: string | undefined, lane?: boolean | undefined }, sessions: Session[]): Promise<(number: number) => string> {
  const name = await me(values.as, sessions)

  if (values.lane !== true)
    return () => name

  const suffix = laneSuffix(name)

  if (suffix === undefined)
    fail(`a lane is named after a session whose name ends in -<n>, not ${name}: pass --as`)

  return number => `lane-${suffix}-${number}`
}

// Runs a step for each issue, reporting a refusal and carrying on with the rest, so the exit code is the worst refusal's.
async function eachIssue(command: string, numbers: number[], step: (number: number) => Promise<void>): Promise<number> {
  let code = 0

  for (const number of numbers) {
    try {
      await step(number)
    }
    catch (error) {
      if (!(error instanceof Exit) || numbers.length === 1)
        throw error

      console.error(`ft ${command}: ${error.message}`)

      if (error.hint !== undefined)
        printHint(error.hint)

      code = Math.max(code, error.code)
    }
  }

  return code
}

export async function take(args: string[]): Promise<number> {
  const parsed = parse(args, takeUsage, takeOptions)

  const { values, positionals } = parsed
  const numbers = issueNumbers(positionals, takeUsage)
  const sessions = await liveSessions()
  const nameFor = await claimant(values, sessions)
  const author = await sessionAuthor()

  return eachIssue('take', numbers, async (number) => {
    const name = nameFor(number)
    const [found, comments] = await Promise.all([getIssue(number, values.repo), commentsOf(number, values.repo)])

    if (found.state === 'closed')
      fail(`#${number} is closed`, 1, runHint(`ft reopen ${number}`, 'reopen it'))

    const claim = latestClaim(comments, author)
    const current = standing(claim, sessions)

    if (claim?.holder === name) {
      console.log(`#${number} is already taken by ${name}`)

      return
    }

    // A session hands its own claim to one of its lanes, or back, as both answer to it.
    if (current.state === 'taken' && holderSession(name, sessions)?.pid !== current.session.pid)
      fail(`#${number} is taken by ${current.claim.holder}${current.session.name === current.claim.holder ? '' : ` in ${current.session.name}`}, which still runs (${current.session.status})`, 1)

    if (current.state === 'away' && values['take-stale'] !== true)
      fail(`#${number} was taken by ${current.claim.holder} ${formatAge(current.claim.at)}, which no session here answers to: it may run on another machine`, 1, runHint(`ft take ${number} --take-stale`, 'take it over'))

    await comment(number, takenComment(name), values.repo)

    // Two sessions can pass the check above together; the latest claim stands, so the one it is not fails.
    const standingNow = latestClaim(await commentsOf(number, values.repo), author)

    if (standingNow?.holder !== name)
      fail(`#${number} was taken by ${standingNow?.holder ?? 'another session'} at the same moment`, 1)

    console.log(`took #${number} as ${name}: ${found.title}`)
  })
}

const dropUsage = `ft drop <n>... [--stale] | --all-stale [--dry-run]

Gives each issue back with a "Released by session <name>." comment, when this session holds it.
With --stale, a claim no session here answers to is released too, in the name of its holder, followed by a comment saying this session released it as stale; a claim a live session holds is still refused. --all-stale does that for every such claim on the board, and with --dry-run only lists them.

Exits 0 when every issue is given back, 1 when one is not held by this session or, with --stale, by a live one, 2 on a usage error.`

const dropOptions = {
  'as': { type: 'string', description: 'the name it was taken as, instead of this session\'s' },
  'stale': { type: 'boolean', description: 'also release a claim no live session here answers to' },
  'all-stale': { type: 'boolean', description: 'release every stale claim of the board, none needing a number' },
  'dry-run': { type: 'boolean', description: 'with --all-stale, list the claims without releasing them' },
  ...laneOption,
  ...repoOption,
} as const

// Releases the claim on an issue in its holder's name, as the claim is only undone by that name's release, then notes who did it; a holder a live session answers to is refused.
async function releaseStale(number: number, me: string, author: string | undefined, sessions: Session[], repo: string | undefined): Promise<void> {
  const claim = latestClaim(await commentsOf(number, repo), author)

  if (claim === undefined)
    fail(`#${number} is not taken`, 1)

  const current = standing(claim, sessions)

  if (current.state === 'taken')
    fail(`#${number} is taken by ${claim.holder}, which still runs (${current.session.status})`, 1)

  await comment(number, releasedComment(claim.holder), repo)
  await comment(number, `Claim of ${claim.holder} from ${formatAge(claim.at)}, which no live session answered to, released as stale by session ${me}.`, repo)
  console.log(`released #${number}, held by ${claim.holder}`)
}

export async function drop(args: string[]): Promise<number> {
  const parsed = parse(args, dropUsage, dropOptions)

  const { values, positionals } = parsed
  const sessions = await liveSessions()
  const nameFor = await claimant(values, sessions)
  const author = await sessionAuthor()

  if (values['dry-run'] === true && values['all-stale'] !== true)
    badUsage('--dry-run goes with --all-stale, which is the one that lists before releasing')

  if (values['all-stale'] === true) {
    if (positionals.length > 0)
      badUsage('--all-stale takes no issue number')

    const rows = await boardRows(await openIssues(undefined, values.repo), sessions, values.repo)
    const stale = rows.flatMap(({ issue, standing: now }) => now.state === 'away' ? [{ issue, holder: now.claim.holder }] : [])

    if (stale.length === 0) {
      console.log('no stale claim')

      return 0
    }

    for (const { issue, holder } of stale)
      console.log(`${values['dry-run'] === true ? 'would release' : 'releasing'} #${issue.number} held by ${holder}: ${issue.title}`)

    if (values['dry-run'] === true)
      return 0

    return eachIssue('drop', stale.map(({ issue }) => issue.number), async (number) => {
      await releaseStale(number, nameFor(number), author, sessions, values.repo)
    })
  }

  const numbers = issueNumbers(positionals, dropUsage)

  return eachIssue('drop', numbers, async (number) => {
    const name = nameFor(number)
    const claim = latestClaim(await commentsOf(number, values.repo), author)

    if (claim !== undefined && claim.holder !== name && values.stale === true) {
      await releaseStale(number, name, author, sessions, values.repo)

      return
    }

    if (claim?.holder !== name)
      fail(`#${number} is ${claim === undefined ? 'not taken' : `taken by ${claim.holder}, not ${name}`}`, 1, claim === undefined ? undefined : runHint(`ft drop ${number} --stale`, 'release it if no session answers to it'))

    await comment(number, releasedComment(name), values.repo)
    console.log(`released #${number}`)
  })
}
