import type { Ticked } from '../checklist'
import type { Named } from '../git'
import type { Issue, IssueComment } from '../issues'
import { fail, formatAge, jsonOption, parse, printJson, readInput, runHint } from '@kaynooo/cli-kit'
import { issueNumber, issueNumbers, repoOption } from '../args'
import { appendBoxes, boxes, numberedBody, referencedBoxes, setBoxes, tickReferences } from '../checklist'
import { latestClaim } from '../claims'
import { commitsNaming, defaultBranch, git, resolveCommit } from '../git'
import { close, comment, commentsOf, createIssue, editBody, editIssue, getIssue, openIssues, sessionAuthor } from '../issues'
import { findMilestone } from '../milestones'
import { heldIssues } from './board'
import { checkLabels } from './triage'

const issueUsage = `ft issue [<n>...]

Prints each issue: its title, state, boxes left and claim, then its description with each checklist box numbered as \`ft tick\` takes it.
With --body, prints only the raw description, to edit and give back to \`ft edit -F\`.
With no number, prints the open issues this session holds (\`ft take\`), and exits 2 when it holds none.

Exits 0 when it printed them, 1 when an issue cannot be read, 2 on a usage error.`

const issueOptions = {
  todo: { type: 'boolean', short: 't', description: 'only the header and the boxes left to tick' },
  comments: { type: 'boolean', short: 'c', description: 'add the comments, each with its author and age' },
  body: { type: 'boolean', short: 'b', description: 'only the raw description, without numbered boxes' },
  json: jsonOption('number, title, state, url, labels, claim, boxes, body and comments, an array for several issues'),
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

  if (values.body === true) {
    const bodies = await Promise.all(numbers.map(async number => (await getIssue(number, values.repo)).body.replaceAll('\r\n', '\n')))

    console.log(bodies.join('\n\n'))

    return 0
  }

  const read = await Promise.all(numbers.map(async number => Promise.all([getIssue(number, values.repo), commentsOf(number, values.repo)])))

  const author = await sessionAuthor()

  if (values.json === true) {
    const json = read.map(([found, comments]) => issueJson(found, comments, author))

    printJson(json.length === 1 ? json[0] : json)

    return 0
  }

  const view = { todo: values.todo === true, comments: values.comments === true, author }

  console.log(read.map(([found, comments]) => renderIssue(found, comments, view)).join(view.todo ? '\n\n' : '\n\n\n'))

  return 0
}

const ISSUE_REFERENCE = /^#?\d+$/

// The issue a writer targets and the arguments after it: the first one when it is an issue number, else the single issue this session holds.
async function targetIssue(positionals: string[], repo: string | undefined, usage: string): Promise<{ number: number, rest: string[] }> {
  if (positionals[0] !== undefined && ISSUE_REFERENCE.test(positionals[0]))
    return { number: issueNumber(positionals[0], usage), rest: positionals.slice(1) }

  const [only, ...others] = await heldIssues(repo)

  if (only === undefined || others.length > 0)
    fail(`${only === undefined ? 'an issue number is needed, this session holds none' : 'an issue number is needed, this session holds several'}\n\n${usage}`)

  return { number: only, rest: positionals }
}

const noteOptions = {
  message: { type: 'string', short: 'm', description: 'comment this text on the issue' },
  file: { type: 'string', short: 'F', description: 'comment the text of this file, - for stdin' },
} as const

// The comment a command posts, from -m or -F, read before anything is written so a missing file changes nothing.
async function noteText(values: { message?: string | undefined, file?: string | undefined }): Promise<string | undefined> {
  if (values.message !== undefined && values.file !== undefined)
    fail('give the comment once, as text or with -F')

  const text = values.file === undefined ? values.message : await readInput(values.file)

  return text?.trim() === '' ? undefined : text?.trim()
}

const NOT_FOUND = /not exist|not found|couldn't be found/i

// An issue Forgejo does not know, such as another repo's number, counts as open; any other failure is thrown, as it says nothing about the state.
async function isClosed(number: number, repo: string | undefined): Promise<boolean> {
  try {
    return (await getIssue(number, repo)).state === 'closed'
  }
  catch (error) {
    if (error instanceof Error && NOT_FOUND.test(error.message))
      return false

    throw error
  }
}

// The issues a body lists in unticked boxes that are closed; one that cannot be read, such as another repo's, counts as open.
async function closedReferences(body: string, repo: string | undefined): Promise<Set<number>> {
  const listed = [...new Set(referencedBoxes(body).filter(({ box }) => !box.done).map(({ issue }) => issue))]
  const states = await Promise.all(listed.map(async issue => isClosed(issue, repo)))

  return new Set(listed.filter((_, at) => states[at] === true))
}

const newUsage = `ft new -t <title> [-F <file>] [-L a,b] [-m <milestone>]

Creates an issue and prints its number and url. The description is read from -F <file>, or from stdin with -F -, and is empty without it. A label or milestone the repository lacks is refused before anything is created.

Exits 0 when it created the issue, 1 when Forgejo refuses, 2 on a usage error or a label or milestone the repository lacks.`

const newOptions = {
  title: { type: 'string', short: 't', description: 'the issue title' },
  file: { type: 'string', short: 'F', description: 'the description: a file, - for stdin' },
  labels: { type: 'string', short: 'L', description: 'comma-separated labels' },
  milestone: { type: 'string', short: 'm', description: 'the milestone, a title or an id; the repository must have it' },
  ...repoOption,
} as const

// The title of the milestone a reference names, refused when the repository has none, or an empty string to clear it.
async function milestoneTitle(reference: string | undefined, repo: string | undefined): Promise<string | undefined> {
  if (reference === undefined)
    return undefined

  return reference.trim() === '' ? '' : (await findMilestone(reference.trim(), repo)).title
}

export async function newIssue(args: string[]): Promise<number> {
  const parsed = parse(args, newUsage, newOptions)

  const { values } = parsed

  if (values.title === undefined || values.title.trim() === '')
    fail(`give the issue a title with -t\n\n${newUsage}`)

  const body = await noteText({ file: values.file })

  await checkLabels((values.labels ?? '').split(',').map(name => name.trim()).filter(name => name !== ''), values.repo)

  const milestone = await milestoneTitle(values.milestone, values.repo)
  const created = await createIssue(values.title.trim(), body ?? '', values.labels, milestone === '' ? undefined : milestone, values.repo)

  console.log(`#${created.number} ${created.html_url}`)

  return 0
}

const editUsage = `ft edit <n> [-t <title>] [-F <file> [--append]] [--add-box <text>]... [-m <milestone>]

Replaces the title and/or the description of issue <n>, the description from -F <file> or from stdin with -F -.
-m moves it to a milestone given by title or id, and \`-m ''\` takes it out of its milestone.
--append adds the -F text after the description instead, and each --add-box an unticked box after the last one, the rest of the description untouched.
\`ft issue <n> --body\` prints the description to edit.

Exits 0 when it edited the issue, 1 when Forgejo refuses, 2 on a usage error.`

const editOptions = {
  'title': { type: 'string', short: 't', description: 'the new title' },
  'file': { type: 'string', short: 'F', description: 'the new description: a file, - for stdin' },
  'append': { type: 'boolean', short: 'a', description: 'add the -F text after the description instead of replacing it' },
  'add-box': { type: 'string', multiple: true, description: 'add an unticked box after the last one, repeatable' },
  'milestone': { type: 'string', short: 'm', description: 'move the issue to this milestone, a title or an id; an empty value takes it out of its milestone' },
  ...repoOption,
} as const

export async function edit(args: string[]): Promise<number> {
  const parsed = parse(args, editUsage, editOptions)

  const { values, positionals } = parsed
  const number = issueNumber(positionals[0], editUsage)
  const text = await noteText({ file: values.file })
  const added = values['add-box'] ?? []

  if (values.file !== undefined && text === undefined)
    fail('the description file is empty')

  if (values.append === true && text === undefined)
    fail('--append adds the -F text, give -F')

  if (values.title === undefined && text === undefined && added.length === 0 && values.milestone === undefined)
    fail(`nothing to change: give -t, -F, --add-box or -m\n\n${editUsage}`)

  const change: { title?: string, body?: string, milestone?: string } = values.title === undefined ? {} : { title: values.title.trim() }
  const milestone = await milestoneTitle(values.milestone, values.repo)

  if (milestone !== undefined)
    change.milestone = milestone

  const grows = (text !== undefined && values.append === true) || added.length > 0

  if (text !== undefined && !grows)
    change.body = text

  if (Object.keys(change).length > 0)
    await editIssue(number, change, values.repo)

  // Adding to the description re-reads it right before writing, so a tick or an edit made meanwhile is kept.
  if (grows) {
    // A retry after a lost update runs this on the body again, so what is already in it is not added twice.
    await editBody(number, (body) => {
      const appended = text !== undefined && values.append === true && !body.trimEnd().endsWith(text) ? `${body.trimEnd()}\n\n${text}` : body
      const present = new Set(boxes(appended).map(box => box.text))
      const missing = added.filter(box => !present.has(box))

      return missing.length > 0 ? appendBoxes(appended, missing) : appended
    }, values.repo)
  }

  console.log(`edited #${number}`)

  return 0
}

const tickUsage = `ft tick [<n>] <box>...

Ticks checklist boxes of issue <n>, each given by its number from \`ft issue\` or by text matching exactly one box, then posts the -m or -F comment.
With --closed, ticks instead every box opening with \`#<issue>\` whose issue is closed, as a release plan lists them.

Without <n> (a first argument that is not a number) it takes the one open issue this session holds (\`ft take\`), and exits 2 when it holds none or several.

Exits 0 when it ticked the boxes, 1 when Forgejo refuses, 2 on a usage error or a box matching none or several.`

const tickOptions = {
  undo: { type: 'boolean', short: 'u', description: 'untick them instead' },
  closed: { type: 'boolean', description: 'tick the boxes listing a closed issue, no box to name' },
  ...noteOptions,
  ...repoOption,
} as const

function tickedOrFail(number: number, run: () => Ticked): Ticked {
  try {
    return run()
  }
  catch (error) {
    fail(`#${number}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function tick(args: string[]): Promise<number> {
  const parsed = parse(args, tickUsage, tickOptions)

  const { values, positionals } = parsed
  const { number, rest: picks } = await targetIssue(positionals, values.repo, tickUsage)

  if (values.closed === true && (picks.length > 0 || values.undo === true))
    fail(`--closed takes no boxes and no --undo\n\n${tickUsage}`)

  if (picks.length === 0 && values.closed !== true)
    fail(`name the boxes to tick\n\n${tickUsage}`)

  const note = await noteText(values)
  const found = await getIssue(number, values.repo)
  const done = values.undo !== true
  const closed = values.closed === true ? await closedReferences(found.body, values.repo) : undefined
  const apply = (body: string) => closed === undefined ? setBoxes(body, picks, done) : tickReferences(body, issue => closed.has(issue))
  let result = tickedOrFail(number, () => apply(found.body))

  // The write re-reads the description and ticks again on it, so a box added above since `ft issue` printed is not ticked in its place.
  if (result.changed.length > 0) {
    await editBody(number, (body) => {
      result = tickedOrFail(number, () => apply(body))

      return result.body
    }, values.repo)
  }

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

const commentUsage = `ft comment [<n>] [text]

Posts a comment on issue <n>: the text given, -F <file>, or stdin when neither is, so a heredoc needs no escaping.
Without <n> (a first argument that is not a number) it takes the one open issue this session holds (\`ft take\`), and exits 2 when it holds none or several.

Exits 0 when it posted the comment, 1 when Forgejo refuses, 2 on a usage error.`

const commentOptions = {
  file: noteOptions.file,
  ...repoOption,
} as const

export async function commentOn(args: string[]): Promise<number> {
  const parsed = parse(args, commentUsage, commentOptions)

  const { values, positionals } = parsed
  const { number, rest } = await targetIssue(positionals, values.repo, commentUsage)
  const given = rest.join(' ') || undefined
  const text = await noteText({ message: given, file: values.file ?? (given === undefined ? '-' : undefined) })

  if (text === undefined)
    fail(`nothing to comment\n\n${commentUsage}`)

  await comment(number, text, values.repo)
  console.log(`commented on #${number}`)

  return 0
}

const fixedUsage = `ft fixed [<n>] [commit]...

Comments "Fixed in <sha>: <message>" on issue <n> and closes it, naming each commit given as "Fixed in <a>, <b> and <c>".
Without a commit it takes those on origin's default branch whose message names #<n>, and says which, or HEAD when none does.
Without <n> it takes the one open issue this session holds (\`ft take\`). The message defaults to the subject of the first commit. Every open issue listing \`- [ ] #<n>\` in its checklist gets that line ticked. An issue with boxes left is refused, as a partly done issue stays open, unless --tick ticks them first.

Exits 0 when it closed the issue, 1 when the issue is already closed, has boxes left or Forgejo refuses, 2 on a usage error.`

const fixedOptions = {
  message: { type: 'string', short: 'm', description: 'the line after "Fixed in <sha>:"' },
  tick: { type: 'boolean', description: 'tick the boxes left before closing' },
  force: { type: 'boolean', description: 'close even with boxes left' },
  ...repoOption,
} as const

// "a", "a and b", "a, b and c".
export function joinShas(shas: string[]): string {
  const last = shas.at(-1) ?? ''

  return shas.length < 2 ? last : `${shas.slice(0, -1).join(', ')} and ${last}`
}

// The commits an issue was fixed in: those given, else those of origin's default branch naming it, else HEAD.
async function fixingCommits(number: number, given: string[]): Promise<Named[]> {
  if (given.length > 0) {
    const named: Named[] = []

    for (const ref of given) {
      const sha = await resolveCommit(ref)

      named.push({ sha, subject: await git(['log', '-1', '--format=%s', sha]) })
    }

    return named
  }

  const ref = `origin/${await defaultBranch()}`
  const found = await commitsNaming(number, ref)

  if (found.length > 0) {
    console.log(`commits on ${ref} naming #${number}:\n${found.map(each => `  ${each.sha.slice(0, 7)} ${each.subject}`).join('\n')}`)

    return found
  }

  const sha = await resolveCommit('HEAD')

  console.log(`no commit on ${ref} names #${number}, using HEAD`)

  return [{ sha, subject: await git(['log', '-1', '--format=%s', sha]) }]
}

// Ticks the line listing a closed issue in every open issue's checklist, as a release plan does.
async function tickListings(closed: number, repo: string | undefined): Promise<void> {
  for (const listing of await openIssues(undefined, repo)) {
    if (!referencedBoxes(listing.body).some(({ box, issue }) => issue === closed && !box.done))
      continue

    if (await editBody(listing.number, body => tickReferences(body, issue => issue === closed).body, repo))
      console.log(`ticked #${closed} in #${listing.number}`)
  }
}

export async function fixed(args: string[]): Promise<number> {
  const parsed = parse(args, fixedUsage, fixedOptions)

  const { values, positionals } = parsed
  const { number, rest } = await targetIssue(positionals, values.repo, fixedUsage)
  const commits = await fixingCommits(number, rest)
  const found = await getIssue(number, values.repo)

  if (found.state === 'closed')
    fail(`#${number} is already closed`, 1, runHint(`ft reopen ${number}`, 'reopen it'))

  const left = boxes(found.body).filter(box => !box.done)

  if (left.length > 0 && values.tick === true) {
    await editBody(number, body => setBoxes(body, boxes(body).filter(box => !box.done).map(box => String(box.number)), true).body, values.repo)
    console.log(`ticked ${left.length} box${left.length === 1 ? '' : 'es'} of #${number}`)
  }
  else if (left.length > 0 && values.force !== true) {
    fail(`#${number} has ${left.length} boxes left:\n${left.map(box => `${String(box.number).padStart(3)} [ ] ${box.text}`).join('\n')}`, 1, `${runHint(`ft fixed ${number} --tick`, 'tick them and close')}, or ${runHint(`ft fixed ${number} --force`, 'close with them left')}`)
  }

  const shas = joinShas(commits.map(each => each.sha.slice(0, 7)))

  const line = `Fixed in ${shas}: ${values.message ?? commits[0]?.subject ?? ''}`

  // A rerun after a failed close finds its own comment already last and does not post it twice.
  if ((await commentsOf(number, values.repo)).at(-1)?.body.trim() !== line.trim())
    await comment(number, line, values.repo)

  await close(number, values.repo)
  console.log(`closed #${number}: fixed in ${shas}`)
  await tickListings(number, values.repo)

  return 0
}
