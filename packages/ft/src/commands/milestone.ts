import type { ExitRow } from '@kaynooo/cli-kit'
import type { Issue } from '../issues'
import type { Milestone } from '../milestones'
import process from 'node:process'
import { bar, capped, fail, jsonOption, limitOf, limitOptions, liveSessions, paint, parse, pool, printJson, role, runHint, section, table, takesControlCodes, truncate } from '@kaynooo/cli-kit'
import { counted } from '@kaynooo/utils/text'
import { repoOption } from '../args'
import { concurrencyOf } from '../config'
import { good } from '../good'
import { closedIssues, openIssues } from '../issues'
import { closeMilestone, createMilestone, dueDate, dueOn, findMilestone, listMilestones, progress } from '../milestones'
import { boardJson, boardRows, renderBoard } from './board'

const TITLE_WIDTH = 60
const LIST_LIMIT = 30
const CONCURRENCY = 4

function counts(milestone: Milestone): string {
  return `${milestone.open_issues} open, ${milestone.closed_issues} closed`
}

// The bar of closed over all issues, empty off a terminal where the percentage says the same.
function progressBar(milestone: Milestone): string {
  const total = milestone.open_issues + milestone.closed_issues

  return takesControlCodes(process.stdout) ? bar(total === 0 ? 0 : milestone.closed_issues / total, { width: 16 }) : ''
}

function milestoneCells(each: Milestone, showState: boolean): string[] {
  const drawn = progressBar(each)

  return [String(each.id), truncate(each.title, TITLE_WIDTH), `${each.open_issues} open`, `${each.closed_issues} closed`, ...drawn === '' ? [] : [drawn], progress(each), dueDate(each) === '' ? '' : `due ${dueDate(each)}`, ...showState ? [each.state] : []]
}

// Each milestone as a titled section with its bar, then its open issues and its closed ones dimmed.
async function printWithIssues(list: Milestone[], repo: string | undefined): Promise<void> {
  const colors = paint(process.stdout)
  const id = role('id', process.stdout)
  const issuesOf = await pool(list, concurrencyOf(CONCURRENCY), async each => Promise.all([openIssues(undefined, repo, each.id), closedIssues(each.id, repo)]))
  const blocks = list.map((each, index) => {
    const byNumber = (left: Issue, right: Issue) => left.number - right.number
    const [open, closed] = issuesOf[index]!.map(found => found.toSorted(byNumber)) as [Issue[], Issue[]]
    const drawn = progressBar(each)
    const facts = [counts(each), progress(each), dueDate(each) === '' ? '' : `due ${dueDate(each)}`].filter(fact => fact !== '').join(', ')
    const lines = [
      ...open.map(issue => `  ${id(`#${issue.number}`)}  ${truncate(issue.title, TITLE_WIDTH)}`),
      ...closed.map(issue => colors.dim(`  #${issue.number}  ${truncate(issue.title, TITLE_WIDTH)} (closed)`)),
    ]

    return [section(`${each.title}${drawn === '' ? '' : `  ${drawn}`}  ${facts}`, undefined, process.stdout, process.env, 'accent'), ...lines].join('\n')
  })

  console.log(blocks.join('\n\n'))
}

const listUsage = `ft milestones

Lists the repository's milestones, the open ones unless --state says otherwise, with the issues open and closed in each, the progress and the due date; on a terminal the progress is a bar, and --issues lists the title of every issue under its milestone.`
const listExits: ExitRow[] = [[0, 'it listed them'], [1, 'Forgejo refuses'], [2, 'a usage error']]

const listOptions = {
  state: { type: 'string', choices: ['open', 'closed', 'all'], default: 'open', description: 'which milestones to list (open)' },
  issues: { type: 'boolean', short: 'i', description: 'list the open and closed issues of each milestone by title' },
  ...limitOptions(LIST_LIMIT),
  json: jsonOption('id, title, state, description, open, closed, due (YYYY-MM-DD or null)'),
  ...repoOption,
} as const

export async function milestones(args: string[]): Promise<number> {
  const parsed = parse(args, listUsage, listOptions, { exits: listExits })

  const { values } = parsed
  const state = values.state
  const limit = limitOf(values, LIST_LIMIT)
  const found = await listMilestones(state, values.repo)

  if (values.issues === true && values.json === true)
    fail('--issues lists for a person, --json has the counts only')

  if (values.json === true) {
    printJson(found.slice(0, limit).map(each => ({ id: each.id, title: each.title, state: each.state, description: each.description, open: each.open_issues, closed: each.closed_issues, due: dueDate(each) || null })))

    return 0
  }

  if (found.length === 0) {
    console.log(`no ${state === 'all' ? '' : `${state} `}milestone`)

    return 0
  }

  const { shown, footer } = capped(found, limit)

  if (values.issues === true)
    await printWithIssues(shown, values.repo)
  else
    console.log(table(shown.map(each => milestoneCells(each, state === 'all'))))

  if (footer !== undefined)
    console.log(footer)

  return 0
}

const newUsage = `ft milestone new <title> [-d <text>] [--due <YYYY-MM-DD>]

Creates a milestone through the API and prints its id. Without --due it has no due date.`
const newExits: ExitRow[] = [[0, 'it created the milestone'], [1, 'Forgejo refuses'], [2, 'a usage error']]

const newOptions = {
  description: { type: 'string', short: 'd', description: 'the milestone description' },
  due: { type: 'string', description: 'the due date, YYYY-MM-DD' },
  ...repoOption,
} as const

async function create(args: string[]): Promise<number> {
  const parsed = parse(args, newUsage, newOptions, { exits: newExits })

  const { values, positionals } = parsed
  const title = positionals.join(' ').trim()

  if (title === '')
    fail(`give the milestone a title\n\n${newUsage}`)

  const due = values.due === undefined ? undefined : dueOn(values.due)
  const created = await createMilestone(title, values.description, due, values.repo)

  console.log(`milestone ${created.id} ${created.title}${dueDate(created) === '' ? '' : `, due ${dueDate(created)}`}`)

  return 0
}

const closeUsage = `ft milestone close <title|id> [--force]

Closes a milestone, refused while issues are open in it, which it names. --force closes it with them left.`
const closeExits: ExitRow[] = [[0, 'it closed the milestone'], [1, 'issues are open in it or Forgejo refuses'], [2, 'a usage error']]

const closeOptions = {
  force: { type: 'boolean', description: 'close it with issues left open' },
  ...repoOption,
} as const

async function closeOne(args: string[]): Promise<number> {
  const parsed = parse(args, closeUsage, closeOptions, { exits: closeExits })

  const { values, positionals } = parsed
  const reference = positionals.join(' ').trim()

  if (reference === '')
    fail(`name the milestone to close\n\n${closeUsage}`)

  const found = await findMilestone(reference, values.repo)

  if (found.state === 'closed') {
    console.log(`milestone ${found.title} is already closed`)

    return 0
  }

  const open = await openIssues(undefined, values.repo, found.id)

  if (open.length > 0 && values.force !== true)
    fail(`milestone ${found.title} has ${counted(open.length, 'open issue')}:\n${open.map(issue => `  #${issue.number} ${truncate(issue.title, TITLE_WIDTH)}`).join('\n')}`, 1, `${runHint(`ft milestone close ${found.title} --force`, 'close it with them open')}, or move them with \`ft edit <n> -m <milestone>\``)

  await closeMilestone(found.id, values.repo)
  console.log(good(`closed milestone ${found.title}`))

  return 0
}

const showUsage = `ft milestone [<title|id>]
ft milestone new <title> [-d <text>] [--due <YYYY-MM-DD>]
ft milestone close <title|id> [--force]

Shows a milestone with its open issues as \`ft board\` does: available, taken by a session running here, or claimed by one gone, each with its boxes left, at most 30 of each kind (--full for all); with no title or id it lists the milestones as \`ft milestones\` does.
\`ft milestone new\` and \`ft milestone close\` have their own --help; a milestone titled new or close is named by its id.`
const showExits: ExitRow[] = [[0, 'it showed the milestone'], [1, 'it cannot be read'], [2, 'a usage error or an unknown milestone']]

const showOptions = {
  ...limitOptions(LIST_LIMIT),
  json: jsonOption('the milestone (id, title, state, description, open, closed, due) and its open issues as `ft board --json` lists them'),
  ...repoOption,
} as const

async function show(args: string[]): Promise<number> {
  const parsed = parse(args, showUsage, showOptions, { exits: showExits })

  const { values, positionals } = parsed
  const reference = positionals.join(' ').trim()

  if (reference === '')
    return milestones(args)

  const found = await findMilestone(reference, values.repo)
  const [issues, sessions] = await Promise.all([openIssues(undefined, values.repo, found.id), liveSessions()])
  const rows = await boardRows(issues, sessions, values.repo)

  if (values.json === true) {
    printJson({ id: found.id, title: found.title, state: found.state, description: found.description, open: found.open_issues, closed: found.closed_issues, due: dueDate(found) || null, issues: boardJson(rows) })

    return 0
  }

  const facts = [found.state, counts(found), progress(found), dueDate(found) === '' ? '' : `due ${dueDate(found)}`].filter(fact => fact !== '')

  console.log(`milestone ${found.title} (${facts.join(', ')})`)

  if (found.description.trim() !== '')
    console.log(found.description.trim())

  console.log(`\n${renderBoard(rows, Date.now(), limitOf(values, LIST_LIMIT))}`)

  return 0
}

export async function milestone(args: string[]): Promise<number> {
  const [first, ...rest] = args

  if (first === 'new')
    return create(rest)

  return first === 'close' ? closeOne(rest) : show(args)
}
