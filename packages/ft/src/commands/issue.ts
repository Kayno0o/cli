import type { Issue, IssueComment } from '../issues'
import { badUsage, copyOption, copyText, formatAge, jsonOption, openUrl, parse, printJson } from '@kaynooo/cli-kit'
import { issueNumbers, openOption, repoOption } from '../args'
import { boxes, numberedBody } from '../checklist'
import { latestClaim } from '../claims'
import { commentsOf, getIssue, sessionAuthor } from '../issues'
import { heldIssues } from './board'

const issueUsage = `ft issue [<n>...]

Prints each issue: its title, state, boxes left and claim, then its description with each checklist box numbered as \`ft tick\` takes it. --open also opens each in the browser.
With --body, prints only the raw description, to edit and give back to \`ft edit -F\`.
With no number, prints the open issues this session holds (\`ft take\`), and exits 2 when it holds none.

Exits 0 when it printed them, 1 when an issue cannot be read, 2 on a usage error.`

const issueOptions = {
  todo: { type: 'boolean', short: 't', description: 'only the header and the boxes left to tick' },
  comments: { type: 'boolean', short: 'c', description: 'add the comments, each with its author and age' },
  body: { type: 'boolean', short: 'b', description: 'only the raw description, without numbered boxes' },
  json: jsonOption('number, title, state, url, labels, claim, boxes, body and comments, an array for several issues'),
  copy: copyOption('the description --body prints'),
  ...openOption,
  ...repoOption,
} as const

export interface IssueView { todo: boolean, comments: boolean, author?: string | undefined }

// Renders an issue as `ft issue` prints it, now being the time ages are counted from.
export function renderIssue(found: Issue, comments: IssueComment[], view: IssueView, now = Date.now()): string {
  const claim = latestClaim(comments, view.author)
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

function issueJson(found: Issue, comments: IssueComment[], author: string | undefined) {
  return {
    number: found.number,
    title: found.title,
    state: found.state,
    url: found.html_url,
    labels: found.labels.map(label => label.name),
    claim: latestClaim(comments, author) ?? null,
    boxes: boxes(found.body).map(({ number, done, text }) => ({ number, done, text })),
    body: found.body,
    comments: comments.map(each => ({ author: each.user.login, at: each.created_at, body: each.body })),
  }
}

export async function issue(args: string[]): Promise<number> {
  const parsed = parse(args, issueUsage, issueOptions)

  const { values, positionals } = parsed
  const held = positionals.length === 0 ? await heldIssues(values.repo) : []
  const numbers = held.length === 0 ? issueNumbers(positionals, issueUsage) : held

  if (values.copy === true && values.body !== true)
    badUsage('--copy goes with --body')

  if (values.body === true) {
    const bodies = await Promise.all(numbers.map(async number => (await getIssue(number, values.repo)).body.replaceAll('\r\n', '\n')))

    console.log(bodies.join('\n\n'))

    if (values.copy === true && !await copyText(bodies.join('\n\n')))
      console.error('warning: no clipboard tool found (wl-copy, xclip, xsel, pbcopy)')

    return 0
  }

  const read = await Promise.all(numbers.map(async number => Promise.all([getIssue(number, values.repo), commentsOf(number, values.repo)])))

  const author = await sessionAuthor()

  if (values.open === true) {
    for (const [found] of read)
      openUrl(found.html_url)
  }

  if (values.json === true) {
    const json = read.map(([found, comments]) => issueJson(found, comments, author))

    printJson(json.length === 1 ? json[0] : json)

    return 0
  }

  const view = { todo: values.todo === true, comments: values.comments === true, author }

  console.log(read.map(([found, comments]) => renderIssue(found, comments, view)).join(view.todo ? '\n\n' : '\n\n\n'))

  return 0
}

export { fixed, joinShas, tick } from './issue-progress'
export { chooseTarget } from './issue-target'
export { commentOn, edit, newIssue } from './issue-write'
