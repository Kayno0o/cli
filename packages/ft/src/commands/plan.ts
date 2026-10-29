import { fail, parse } from '@kaynooo/cli-kit'
import { issueNumber, issueNumbers, repoOption } from '../args'
import { editBody, getIssue } from '../issues'
import { addLines, listedIssues, openLines } from '../plan'

const usage = `ft plan add <plan> <n>... [--section "Bugs:"]
ft plan carry <from> <to> [--section "Carried from 1.71.0:"]

add: lists each issue <n> as \`- [ ] #<n> <title>\` in the checklist of issue <plan>, skipping those already listed.
carry: copies the unticked \`#<n>\` lines of issue <from> into issue <to>, skipping those <to> already lists.
Lines go under --section, created at the end of the body when missing, or else after the checklist's last box.
The body is read again just before it is written, so an edit made meanwhile is kept.`

const options = {
  section: { type: 'string', short: 's', description: 'the heading the lines go under, e.g. "Bugs:"' },
  ...repoOption,
} as const

export async function plan(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  if (parsed === undefined)
    return 0

  const { values, positionals } = parsed
  const [action, ...rest] = positionals

  if (action === 'add')
    return add(rest, values.section, values.repo)

  if (action === 'carry')
    return carry(rest, values.section, values.repo)

  fail(`ft plan add or ft plan carry\n\n${usage}`)
}

async function add(rest: string[], section: string | undefined, repo: string | undefined): Promise<number> {
  const [target, ...listed] = rest
  const planNumber = issueNumber(target, usage)

  if (listed.length === 0)
    fail(`name the issues to add\n\n${usage}`)

  const numbers = issueNumbers(listed, usage)
  const titled = await Promise.all(numbers.map(async number => ({ number, title: (await getIssue(number, repo)).title })))
  let added: string[] = []

  await editBody(planNumber, (body) => {
    const known = listedIssues(body)
    const fresh = titled.filter(({ number }) => !known.has(number))

    added = fresh.map(({ number, title }) => `- [ ] #${number} ${title}`)

    return addLines(body, added, section)
  }, repo)

  report(planNumber, added, titled.length - added.length)

  return 0
}

async function carry(rest: string[], section: string | undefined, repo: string | undefined): Promise<number> {
  const from = issueNumber(rest[0], usage)
  const to = issueNumber(rest[1], usage)
  const source = openLines((await getIssue(from, repo)).body)
  let added: string[] = []

  await editBody(to, (body) => {
    const known = listedIssues(body)

    added = source.filter(({ issue }) => !known.has(issue)).map(({ line }) => line)

    return addLines(body, added, section)
  }, repo)

  report(to, added, source.length - added.length)

  return 0
}

function report(plan: number, added: string[], skipped: number): void {
  for (const line of added)
    console.log(`#${plan}: ${line}`)

  console.log(`#${plan}: ${added.length} added${skipped === 0 ? '' : `, ${skipped} already listed`}`)
}
