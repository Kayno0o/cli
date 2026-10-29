import type { Issue, IssueComment } from '../issues'
import { fail, formatAge, parse } from '@kaynooo/cli-kit'
import { issueNumber, issueNumbers, repoOption } from '../args'
import { boxes, numberedBody, setBoxes } from '../checklist'
import { latestClaim } from '../claims'
import { git, resolveCommit } from '../git'
import { close, comment, commentsOf, getIssue, setBody } from '../issues'

const issueUsage = `ft issue <n>...

Prints each issue: its title, state, boxes left and claim, then its description with each checklist box numbered as \`ft tick\` takes it.`

const issueOptions = {
  todo: { type: 'boolean', short: 't', description: 'only the header and the boxes left to tick' },
  comments: { type: 'boolean', short: 'c', description: 'add the comments, each with its author and age' },
  json: { type: 'boolean', description: 'print JSON: number, title, state, url, labels, claim, boxes, body and comments, an array for several issues' },
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
  const numbers = issueNumbers(positionals, issueUsage)
  const read = await Promise.all(numbers.map(async number => Promise.all([getIssue(number, values.repo), commentsOf(number, values.repo)])))

  if (values.json === true) {
    const json = read.map(([found, comments]) => issueJson(found, comments))

    console.log(JSON.stringify(json.length === 1 ? json[0] : json, null, 2))

    return 0
  }

  const view = { todo: values.todo === true, comments: values.comments === true }

  console.log(read.map(([found, comments]) => renderIssue(found, comments, view)).join(view.todo ? '\n\n' : '\n\n\n'))

  return 0
}

const noteOptions = {
  message: { type: 'string', short: 'm', description: 'comment this text on the issue' },
  file: { type: 'string', short: 'F', description: 'comment the text of this file, - for stdin' },
} as const

// The comment a command posts, from -m or -F, read before anything is written so a missing file changes nothing.
async function noteText(values: { message?: string | undefined, file?: string | undefined }): Promise<string | undefined> {
  if (values.message !== undefined && values.file !== undefined)
    fail('give the comment once, as text or with -F')

  let text = values.message

  if (values.file !== undefined) {
    const file = values.file === '-' ? Bun.stdin : Bun.file(values.file)

    if (values.file !== '-' && !await file.exists())
      fail(`no file ${values.file}`)

    text = await file.text()
  }

  return text?.trim() === '' ? undefined : text?.trim()
}

const tickUsage = `ft tick <n> <box>...

Ticks checklist boxes of issue <n>, each given by its number from \`ft issue\` or by text matching exactly one box, then posts the -m or -F comment.`

const tickOptions = {
  undo: { type: 'boolean', short: 'u', description: 'untick them instead' },
  ...noteOptions,
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

  const note = await noteText(values)
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

  if (note !== undefined) {
    await comment(number, note, values.repo)
    console.log(`commented on #${number}`)
  }

  return 0
}

const commentUsage = `ft comment <n> [text]

Posts a comment on issue <n>: the text given, -F <file>, or stdin when neither is, so a heredoc needs no escaping.`

const commentOptions = {
  file: noteOptions.file,
  ...repoOption,
} as const

export async function commentOn(args: string[]): Promise<number> {
  const parsed = parse(args, commentUsage, commentOptions)

  if (parsed === undefined)
    return 0

  const { values, positionals } = parsed
  const number = issueNumber(positionals[0], commentUsage)
  const given = positionals.slice(1).join(' ') || undefined
  const text = await noteText({ message: given, file: values.file ?? (given === undefined ? '-' : undefined) })

  if (text === undefined)
    fail(`nothing to comment\n\n${commentUsage}`)

  await comment(number, text, values.repo)
  console.log(`commented on #${number}`)

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
