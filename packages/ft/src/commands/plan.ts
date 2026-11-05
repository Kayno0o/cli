import type { Command } from '@kaynooo/cli-kit'
import { fail, parse } from '@kaynooo/cli-kit'
import { issueNumber, issueNumbers, repoOption } from '../args'
import { good } from '../good'
import { editBody, getIssue } from '../issues'
import { addLines, listedIssues, openLines } from '../plan'

const addUsage = `ft plan add <plan> <n>... [--section "Bugs:"]

Lists each issue <n> as \`- [ ] #<n> <title>\` in the checklist of issue <plan>, skipping those already listed.
Lines go under --section, created at the end of the body when missing, or else after the checklist's last box.
The body is read again just before it is written, so an edit made meanwhile is kept.

Exits 0 when it listed the issues, 1 when Forgejo refuses, 2 on a usage error.`

const carryUsage = `ft plan carry <from> <to> [--section "Carried from 1.71.0:"]

Copies the unticked \`#<n>\` lines of issue <from> into issue <to>, skipping those <to> already lists.
Lines go under --section, created at the end of the body when missing, or else after the checklist's last box.
The body is read again just before it is written, so an edit made meanwhile is kept.

Exits 0 when it copied the lines, 1 when Forgejo refuses, 2 on a usage error.`

const options = {
  section: { type: 'string', short: 's', description: 'the heading the lines go under, e.g. "Bugs:"' },
  ...repoOption,
} as const

export const plan: Command = {
  summary: 'add issues to a release plan\'s checklist, or carry its unticked lines to the next plan',
  commands: {
    add: { run: add, summary: 'list issues in a plan\'s checklist' },
    carry: { run: carry, summary: 'copy a plan\'s unticked lines into the next plan' },
  },
}

async function add(args: string[]): Promise<number> {
  const parsed = parse(args, addUsage, options)

  const { section, repo } = parsed.values
  const [target, ...listed] = parsed.positionals
  const planNumber = issueNumber(target, addUsage)

  if (listed.length === 0)
    fail(`name the issues to add\n\n${addUsage}`)

  const numbers = issueNumbers(listed, addUsage)
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

async function carry(args: string[]): Promise<number> {
  const parsed = parse(args, carryUsage, options)

  const { section, repo } = parsed.values
  const from = issueNumber(parsed.positionals[0], carryUsage)
  const to = issueNumber(parsed.positionals[1], carryUsage)
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

  console.log(good(`#${plan}: ${added.length} added${skipped === 0 ? '' : `, ${skipped} already listed`}`))
}
