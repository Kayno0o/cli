import { fail, parse } from '@kaynooo/cli-kit'
import { issueNumber, repoOption } from '../args'
import { appendBoxes, boxes } from '../checklist'
import { good } from '../good'
import { comment, createIssue, editBody, editIssue } from '../issues'
import { findMilestone } from '../milestones'
import { noteOptions, noteText, targetIssue } from './issue-target'
import { checkLabels } from './triage'

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

  if (text !== undefined && values.append !== true)
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

  console.log(good(`edited #${number}`))

  return 0
}

const commentUsage = `ft comment [<n>] [text]

Posts a comment on issue <n>: the text given, -F <file>, or stdin when neither is, so a heredoc needs no escaping.
Without <n> (a first argument that is not a number) it takes the one open issue this session holds (\`ft take\`), and exits 2 when it holds none or several, saying which issue it used. A first argument that is a number is always the issue, so boxes named by number need it.

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
  console.log(good(`commented on #${number}`))

  return 0
}
