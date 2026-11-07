import type { ExitRow } from '@kaynooo/cli-kit'
import type { Ticked } from '../checklist'
import type { Named } from '../git'
import { fail, parse, runHint } from '@kaynooo/cli-kit'
import { repoOption } from '../args'
import { boxes, referencedBoxes, setBoxes, tickReferences } from '../checklist'
import { commitsNaming, defaultBranch, git, resolveCommit } from '../git'
import { good } from '../good'
import { close, comment, commentsOf, editBody, getIssue, openIssues } from '../issues'
import { closedReferences, noteOptions, noteText, targetIssue } from './issue-target'

const tickUsage = `ft tick [<n>] <box>...

Ticks checklist boxes of issue <n>, each given by its number from \`ft issue\` or by text matching exactly one box, then posts the -m or -F comment.
With --closed, ticks instead every box opening with \`#<issue>\` whose issue is closed, as a release plan lists them.

Without <n> (a first argument that is not a number) it takes the one open issue this session holds (\`ft take\`), and exits 2 when it holds none or several, saying which issue it used. A first argument that is a number is always the issue, so boxes named by number need it.`
const tickExits: ExitRow[] = [[0, 'it ticked the boxes'], [1, 'Forgejo refuses'], [2, 'a usage error or a box matching none or several']]

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
  const parsed = parse(args, tickUsage, tickOptions, { exits: tickExits })

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
    console.log(good(`${done ? 'ticked' : 'unticked'} ${box.number}: ${box.text}`))

  const left = boxes(result.body).filter(box => !box.done).length

  console.log(`#${number}: ${result.changed.length === 0 ? 'nothing to change, ' : ''}${left} box${left === 1 ? '' : 'es'} left`)

  if (note !== undefined) {
    await comment(number, note, values.repo)
    console.log(good(`commented on #${number}`))
  }

  return 0
}

const fixedUsage = `ft fixed [<n>] [commit]...

Comments "Fixed in <sha>: <message>" on issue <n> and closes it, naming each commit given as "Fixed in <a>, <b> and <c>".
Without a commit it takes those on origin's default branch whose message names #<n>, and says which, or HEAD when none does.
Without <n> it takes the one open issue this session holds (\`ft take\`). The message defaults to the subject of the first commit. Every open issue listing \`- [ ] #<n>\` in its checklist gets that line ticked. An issue with boxes left is refused, as a partly done issue stays open, unless --tick ticks them first.`
const fixedExits: ExitRow[] = [[0, 'it closed the issue'], [1, 'the issue is already closed, has boxes left or Forgejo refuses'], [2, 'a usage error']]

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
      console.log(good(`ticked #${closed} in #${listing.number}`))
  }
}

export async function fixed(args: string[]): Promise<number> {
  const parsed = parse(args, fixedUsage, fixedOptions, { exits: fixedExits })

  const { values, positionals } = parsed
  const { number, rest } = await targetIssue(positionals, values.repo, fixedUsage)
  const commits = await fixingCommits(number, rest)
  const found = await getIssue(number, values.repo)

  if (found.state === 'closed')
    fail(`#${number} is already closed`, 1, runHint(`ft reopen ${number}`, 'reopen it'))

  const left = boxes(found.body).filter(box => !box.done)

  if (left.length > 0 && values.tick === true) {
    await editBody(number, body => setBoxes(body, boxes(body).filter(box => !box.done).map(box => String(box.number)), true).body, values.repo)
    console.log(good(`ticked ${left.length} box${left.length === 1 ? '' : 'es'} of #${number}`))
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
  console.log(good(`closed #${number}: fixed in ${shas}`))
  await tickListings(number, values.repo)

  return 0
}
