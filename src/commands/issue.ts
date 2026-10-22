import type { Issue, IssueComment } from '../issues'
import { fail, issueNumber, parse, repoOption } from '../args'
import { boxes, numberedBody, setBoxes } from '../checklist'
import { latestClaim } from '../claims'
import { formatAge } from '../format'
import { git, resolveCommit } from '../git'
import { close, comment, commentsOf, getIssue, setBody } from '../issues'

const issueUsage = `ft issue <n>

Prints an issue: its title, state, boxes left and claim, then its description with each checklist box numbered as \`ft tick\` takes it.`

const issueOptions = {
  todo: { type: 'boolean', short: 't', description: 'only the header and the boxes left to tick' },
  comments: { type: 'boolean', short: 'c', description: 'add the comments, each with its author and age' },
  json: { type: 'boolean', description: 'print JSON: number, title, state, url, labels, claim, boxes, body and comments' },
  ...repoOption,
} as const

export interface IssueView { todo: boolean, comments: boolean }

// Renders an issue as `ft issue` prints it, now being the time ages are counted from.
export function renderIssue(found: Issue, comments: IssueComment[], view: IssueView, now = Date.now()): string {
  const claim = latestClaim(comments)
  const list = boxes(found.body)
  const left = list.filter(box => !box.done)
  const facts = [found.state]

  if (list.length > 0)
    facts.push(`${left.length} of ${list.length} boxes left`)

  if (claim !== undefined)
    facts.push(`taken by ${claim.holder} ${formatAge(claim.at, now)}`)

  const header = `#${found.number} ${found.title} (${facts.join(', ')})`

  if (view.todo)
    return [header, ...left.map(box => `${String(box.number).padStart(3)} [ ] ${box.text}`)].join('\n')

  const parts = [`${header}\n${found.html_url}`]
  const body = numberedBody(found.body)

  if (body !== '')
    parts.push(body)

  if (view.comments) {
    for (const each of comments)
      parts.push(`--- ${each.user.login}, ${formatAge(each.created_at, now)}\n${each.body.replaceAll('\r\n', '\n').trim()}`)
  }

  return parts.join('\n\n')
}

function issueJson(found: Issue, comments: IssueComment[]) {
  return {
    number: found.number,
    title: found.title,
    state: found.state,
    url: found.html_url,
    labels: found.labels.map(label => label.name),
    claim: latestClaim(comments) ?? null,
    boxes: boxes(found.body).map(({ number, done, text }) => ({ number, done, text })),
    body: found.body,
    comments: comments.map(each => ({ author: each.user.login, at: each.created_at, body: each.body })),
  }
}

export async function issue(args: string[]): Promise<number> {
  const parsed = parse(args, issueUsage, issueOptions)

  if (parsed === undefined)
    return 0

  const { values, positionals } = parsed
  const number = issueNumber(positionals[0], issueUsage)
  const [found, comments] = await Promise.all([getIssue(number, values.repo), commentsOf(number, values.repo)])

  console.log(values.json === true
    ? JSON.stringify(issueJson(found, comments), null, 2)
    : renderIssue(found, comments, { todo: values.todo === true, comments: values.comments === true }))

  return 0
}

const tickUsage = `ft tick <n> <box>...

Ticks checklist boxes of issue <n>, each given by its number from \`ft issue\` or by text matching exactly one box.`

const tickOptions = {
  undo: { type: 'boolean', short: 'u', description: 'untick them instead' },
  ...repoOption,
} as const

export async function tick(args: string[]): Promise<number> {
  const parsed = parse(args, tickUsage, tickOptions)

  if (parsed === undefined)
    return 0

  const { values, positionals } = parsed
  const number = issueNumber(positionals[0], tickUsage)
  const picks = positionals.slice(1)

  if (picks.length === 0)
    fail(`name the boxes to tick\n\n${tickUsage}`)

  const found = await getIssue(number, values.repo)
  const done = values.undo !== true
  let result

  try {
    result = setBoxes(found.body, picks, done)
  }
  catch (error) {
    fail(`#${number}: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (result.changed.length > 0)
    await setBody(number, result.body, values.repo)

  for (const box of result.changed)
    console.log(`${done ? 'ticked' : 'unticked'} ${box.number}: ${box.text}`)

  const left = boxes(result.body).filter(box => !box.done).length

  console.log(`#${number}: ${result.changed.length === 0 ? 'nothing to change, ' : ''}${left} box${left === 1 ? '' : 'es'} left`)

  return 0
}

const fixedUsage = `ft fixed <n> [commit]

Comments "Fixed in <sha>: <message>" on issue <n> and closes it, the message defaulting to the commit's subject.
An issue with boxes left is refused, as a partly done issue stays open.`

const fixedOptions = {
  message: { type: 'string', short: 'm', description: 'the line after "Fixed in <sha>:"' },
  force: { type: 'boolean', description: 'close even with boxes left' },
  ...repoOption,
} as const

export async function fixed(args: string[]): Promise<number> {
  const parsed = parse(args, fixedUsage, fixedOptions)

  if (parsed === undefined)
    return 0

  const { values, positionals } = parsed
  const number = issueNumber(positionals[0], fixedUsage)
  const sha = await resolveCommit(positionals[1] ?? 'HEAD')
  const found = await getIssue(number, values.repo)

  if (found.state === 'closed')
    fail(`#${number} is already closed`)

  const left = boxes(found.body).filter(box => !box.done)

  if (left.length > 0 && values.force !== true)
    fail(`#${number} has ${left.length} boxes left, tick them or pass --force:\n${left.map(box => `${String(box.number).padStart(3)} [ ] ${box.text}`).join('\n')}`)

  const message = values.message ?? await git(['log', '-1', '--format=%s', sha])

  await comment(number, `Fixed in ${sha.slice(0, 7)}: ${message}`, values.repo)
  await close(number, values.repo)
  console.log(`closed #${number}: fixed in ${sha.slice(0, 7)}`)

  return 0
}
