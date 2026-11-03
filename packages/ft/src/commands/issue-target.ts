import { fail, readInput, warn } from '@kaynooo/cli-kit'
import { issueNumber } from '../args'
import { referencedBoxes } from '../checklist'
import { getIssue } from '../issues'
import { heldIssues } from './board'

const ISSUE_REFERENCE = /^#?\d+$/

// The issue a writer targets and the arguments after it: the first one when it is an issue number, else the single issue this session holds.
export async function chooseTarget(positionals: string[], held: () => Promise<number[]>, usage: string): Promise<{ number: number, rest: string[], defaulted: boolean }> {
  if (positionals[0] !== undefined && ISSUE_REFERENCE.test(positionals[0]))
    return { number: issueNumber(positionals[0], usage), rest: positionals.slice(1), defaulted: false }

  const [only, ...others] = await held()

  if (only === undefined || others.length > 0)
    fail(`an issue number is needed, this session holds ${only === undefined ? 'none' : 'several'}\n\n${usage}`)

  return { number: only, rest: positionals, defaulted: true }
}

// The default says which issue it took, as a number-like first argument is always read as the issue.
export async function targetIssue(positionals: string[], repo: string | undefined, usage: string): Promise<{ number: number, rest: string[] }> {
  const { number, rest, defaulted } = await chooseTarget(positionals, async () => heldIssues(repo), usage)

  if (defaulted)
    warn(`using #${number}, the issue this session holds`)

  return { number, rest }
}

export const noteOptions = {
  message: { type: 'string', short: 'm', description: 'comment this text on the issue' },
  file: { type: 'string', short: 'F', description: 'comment the text of this file, - for stdin' },
} as const

// The comment a command posts, from -m or -F, read before anything is written so a missing file changes nothing.
export async function noteText(values: { message?: string | undefined, file?: string | undefined }): Promise<string | undefined> {
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
export async function closedReferences(body: string, repo: string | undefined): Promise<Set<number>> {
  const listed = [...new Set(referencedBoxes(body).filter(({ box }) => !box.done).map(({ issue }) => issue))]
  const states = await Promise.all(listed.map(async issue => isClosed(issue, repo)))

  return new Set(listed.filter((_, at) => states[at] === true))
}
