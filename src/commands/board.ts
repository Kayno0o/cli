import type { Claim } from '../claims'
import type { Issue, IssueComment } from '../issues'
import type { Session } from '../sessions'
import { Exit, fail, issueNumbers, parse, repoOption } from '../args'
import { boxes } from '../checklist'
import { holderSession, laneSuffix, latestClaim, latestNote, releasedComment, takenComment } from '../claims'
import { formatAge, table, truncate } from '../format'
import { comment, commentsOf, commentsOfAll, getIssue, openIssues } from '../issues'
import { currentSession, liveSessions } from '../sessions'

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

type Claimed = Exclude<Standing, { state: 'available' }>

export interface BoardRow { issue: Issue, standing: Standing, comments: IssueComment[] }

function boxesLeft(issue: Issue): string {
  const list = boxes(issue.body)

  return list.length === 0 ? '' : `${list.filter(box => !box.done).length}/${list.length} left`
}

function claimRow(issue: Issue, row: Claimed, now: number): string[] {
  const holder = row.state === 'taken' && row.session.name !== row.claim.holder ? `${row.claim.holder} via ${row.session.name}` : row.claim.holder
  const status = row.state === 'taken' ? ` (${row.session.status})` : ''

  return [`#${issue.number}`, `${holder}${status}`, formatAge(row.claim.at, now), boxesLeft(issue), truncate(issue.title, TITLE_WIDTH)]
}

// The first line of the latest comment that is not a claim, which tells whether a claim no live session holds landed in part.
function noteLine(comments: IssueComment[], now: number): string[] {
  const note = latestNote(comments)
  const first = note?.body.split('\n').map(line => line.trim()).find(line => line !== '')

  return note === undefined || first === undefined ? [] : [`    ${note.user.login} ${formatAge(note.created_at, now)}: ${truncate(first, NOTE_WIDTH)}`]
}

export function renderBoard(rows: BoardRow[], now = Date.now()): string {
  const available = rows.filter(row => row.standing.state === 'available')
  const claimed = (state: Claimed['state']) => rows.flatMap(({ issue, standing: row, comments }) => row.state === state ? [{ issue, row, comments }] : [])
  const taken = claimed('taken')
  const away = claimed('away')
  const sections = [
    { heading: 'available', count: available.length, lines: table(available.map(({ issue }) => [`#${issue.number}`, truncate(issue.title, TITLE_WIDTH), issue.labels.map(label => label.name).join(', ')])).split('\n') },
    { heading: 'taken', count: taken.length, lines: table(taken.map(({ issue, row }) => claimRow(issue, row, now))).split('\n') },
    { heading: 'claimed, no live session here', count: away.length, lines: table(away.map(({ issue, row }) => claimRow(issue, row, now))).split('\n').flatMap((line, index) => [line, ...noteLine(away[index]?.comments ?? [], now)]) },
  ].filter(section => section.count > 0)

  return sections.length === 0 ? 'no open issue' : sections.map(({ heading, count, lines }) => `${heading} (${count})\n${lines.join('\n').replace(LINE_START, '  ')}`).join('\n\n')
}

const boardUsage = `ft board

Lists open issues as available, taken by a session running here, or claimed by a session no session here answers to, from their latest "Taken by session <name>." comment.
A claim shows its boxes left, and one no live session holds also the latest comment that is not a claim.
A lane's claim (lane-<n>-<issue>) is held while the session whose name ends in -<n> runs.`

const boardOptions = {
  labels: { type: 'string', short: 'L', description: 'only issues with these labels, comma separated' },
  json: { type: 'boolean', description: 'print JSON' },
  ...repoOption,
} as const

export async function board(args: string[]): Promise<number> {
  const parsed = parse(args, boardUsage, boardOptions)

  if (parsed === undefined)
    return 0

  const { values } = parsed
  const [issues, sessions] = await Promise.all([openIssues(values.labels, values.repo), liveSessions()])
  const comments = await commentsOfAll(issues, values.repo)
  const rows = issues.map((issue) => {
    const own = comments.get(issue.number) ?? []

    return { issue, standing: standing(latestClaim(own), sessions), comments: own }
  })

  if (values.json === true) {
    console.log(JSON.stringify(rows.map(({ issue, standing: { state, ...rest }, comments: own }) => {
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
    }), null, 2))

    return 0
  }

  console.log(renderBoard(rows))

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
An issue another live session holds is refused, one this session or its lanes hold passes to the new name, and one claimed by a session no session here answers to needs --take-stale; a refusal leaves the other issues taken and exits 1.`

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
      code = Math.max(code, error.code)
    }
  }

  return code
}

export async function take(args: string[]): Promise<number> {
  const parsed = parse(args, takeUsage, takeOptions)

  if (parsed === undefined)
    return 0

  const { values, positionals } = parsed
  const numbers = issueNumbers(positionals, takeUsage)
  const sessions = await liveSessions()
  const nameFor = await claimant(values, sessions)

  return eachIssue('take', numbers, async (number) => {
    const name = nameFor(number)
    const [found, comments] = await Promise.all([getIssue(number, values.repo), commentsOf(number, values.repo)])

    if (found.state === 'closed')
      fail(`#${number} is closed`, 1)

    const claim = latestClaim(comments)
    const current = standing(claim, sessions)

    if (claim?.holder === name) {
      console.log(`#${number} is already taken by ${name}`)

      return
    }

    // A session hands its own claim to one of its lanes, or back, as both answer to it.
    if (current.state === 'taken' && holderSession(name, sessions)?.pid !== current.session.pid)
      fail(`#${number} is taken by ${current.claim.holder}${current.session.name === current.claim.holder ? '' : ` in ${current.session.name}`}, which still runs (${current.session.status})`, 1)

    if (current.state === 'away' && values['take-stale'] !== true)
      fail(`#${number} was taken by ${current.claim.holder} ${formatAge(current.claim.at)}, which no session here answers to: it may run on another machine, so pass --take-stale to take it over`, 1)

    await comment(number, takenComment(name), values.repo)
    console.log(`took #${number} as ${name}: ${found.title}`)
  })
}

const dropUsage = `ft drop <n>...

Gives each issue back with a "Released by session <name>." comment, when this session holds it.`

const dropOptions = {
  as: { type: 'string', description: 'the name it was taken as, instead of this session\'s' },
  ...laneOption,
  ...repoOption,
} as const

export async function drop(args: string[]): Promise<number> {
  const parsed = parse(args, dropUsage, dropOptions)

  if (parsed === undefined)
    return 0

  const { values, positionals } = parsed
  const numbers = issueNumbers(positionals, dropUsage)
  const nameFor = await claimant(values, await liveSessions())

  return eachIssue('drop', numbers, async (number) => {
    const name = nameFor(number)
    const claim = latestClaim(await commentsOf(number, values.repo))

    if (claim?.holder !== name)
      fail(`#${number} is ${claim === undefined ? 'not taken' : `taken by ${claim.holder}, not ${name}`}`, 1)

    await comment(number, releasedComment(name), values.repo)
    console.log(`released #${number}`)
  })
}
