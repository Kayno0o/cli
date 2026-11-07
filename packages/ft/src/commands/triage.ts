import type { ExitRow } from '@kaynooo/cli-kit'
import { fail, parse } from '@kaynooo/cli-kit'
import { issueNumber, issueNumbers, repoOption } from '../args'
import { good } from '../good'
import { close, comment, editLabels, getIssue, reopen, repoLabels } from '../issues'

// Fails on a label the repository lacks, listing those it has, before anything is written.
export async function checkLabels(names: string[], repo: string | undefined): Promise<void> {
  if (names.length === 0)
    return

  const known = await repoLabels(repo)
  const missing = names.filter(name => !known.includes(name))

  if (missing.length > 0)
    fail(`no label ${missing.join(', ')} in this repository, ${known.length === 0 ? 'which has none' : `it has: ${known.join(', ')}`}`)
}

const stateOptions = {
  message: { type: 'string', short: 'm', description: 'a comment posted first, saying why' },
  ...repoOption,
} as const

async function setState(args: string[], usage: string, exits: ExitRow[], wanted: 'open' | 'closed'): Promise<number> {
  const parsed = parse(args, usage, stateOptions, { exits })

  const { values, positionals } = parsed

  for (const number of issueNumbers(positionals, usage)) {
    if ((await getIssue(number, values.repo)).state === wanted) {
      console.log(`#${number} is already ${wanted}`)

      continue
    }

    if (values.message !== undefined && values.message.trim() !== '')
      await comment(number, values.message.trim(), values.repo)

    if (wanted === 'closed')
      await close(number, values.repo)
    else
      await reopen(number, values.repo)

    console.log(good(`${wanted === 'closed' ? 'closed' : 'reopened'} #${number}`))
  }

  return 0
}

const closeUsage = `ft close <n>... [-m <reason>]

Closes issues without a fix, a duplicate or one dropped, posting the -m reason first. \`ft fixed\` closes one a commit fixed.`
const closeExits: ExitRow[] = [[0, 'every issue is closed'], [1, 'Forgejo refuses'], [2, 'a usage error']]

export async function closeIssues(args: string[]): Promise<number> {
  return setState(args, closeUsage, closeExits, 'closed')
}

const reopenUsage = `ft reopen <n>... [-m <reason>]

Reopens closed issues, posting the -m reason first.`
const reopenExits: ExitRow[] = [[0, 'every issue is open'], [1, 'Forgejo refuses'], [2, 'a usage error']]

export async function reopenIssues(args: string[]): Promise<number> {
  return setState(args, reopenUsage, reopenExits, 'open')
}

const LABEL_FLAGS = new Set(['-h', '--help'])
const REPO_FLAGS = new Set(['-r', '--repo'])

// `+name` and `-name` taken out of the arguments, as parsing would read `-name` as an option.
function labelChanges(args: string[]): { rest: string[], add: string[], remove: string[] } {
  const rest: string[] = []
  const add: string[] = []
  const remove: string[] = []

  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? ''

    if (REPO_FLAGS.has(arg) && at + 1 < args.length)
      rest.push(arg, args[++at] ?? '')
    else if (arg.startsWith('+') && arg.length > 1)
      add.push(arg.slice(1))
    else if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1 && !LABEL_FLAGS.has(arg) && !REPO_FLAGS.has(arg))
      remove.push(arg.slice(1))
    else
      rest.push(arg)
  }

  return { rest, add, remove }
}

const labelUsage = `ft label <n> [+]<label>... -<label>...

Adds the labels named bare or with +, removes those named with -, then prints the issue's labels. A label the repository lacks is refused.`
const labelExits: ExitRow[] = [[0, 'it changed the labels'], [1, 'Forgejo refuses'], [2, 'a usage error or a label the repository lacks']]

export async function label(args: string[]): Promise<number> {
  const changes = labelChanges(args)
  const parsed = parse(changes.rest, labelUsage, repoOption, { exits: labelExits })

  const { values, positionals } = parsed
  const number = issueNumber(positionals[0], labelUsage)
  const add = [...positionals.slice(1), ...changes.add]
  const { remove } = changes

  if (add.length === 0 && remove.length === 0)
    fail(`name labels to add or remove\n\n${labelUsage}`)

  const both = add.filter(name => remove.includes(name))

  if (both.length > 0)
    fail(`${both.join(', ')} is both added and removed`)

  await checkLabels(add, values.repo)
  await editLabels(number, add, remove, values.repo)

  const labels = (await getIssue(number, values.repo)).labels.map(each => each.name)

  console.log(`#${number} labels: ${labels.length === 0 ? 'none' : labels.join(', ')}`)

  return 0
}
