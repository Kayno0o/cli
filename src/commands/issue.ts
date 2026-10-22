import { fail, issueNumber, parse, repoOption } from '../args'
import { boxes, setBoxes } from '../checklist'
import { latestClaim } from '../claims'
import { formatAge } from '../format'
import { git, resolveCommit } from '../git'
import { close, comment, commentsOf, getIssue, setBody } from '../issues'

const issueUsage = `ft issue <n>

Prints an issue's title, state, claim and its checklist boxes with their numbers, as \`ft tick\` takes them.`

const issueOptions = {
  todo: { type: 'boolean', short: 't', description: 'only the boxes left to tick' },
  ...repoOption,
} as const

export async function issue(args: string[]): Promise<number> {
  const parsed = parse(args, issueUsage, issueOptions)

  if (parsed === undefined)
    return 0

  const { values, positionals } = parsed
  const number = issueNumber(positionals[0], issueUsage)
  const [found, comments] = await Promise.all([getIssue(number, values.repo), commentsOf(number, values.repo)])
  const claim = latestClaim(comments)
  const list = boxes(found.body)
  const left = list.filter(box => !box.done)

  console.log(`#${found.number} ${found.title} (${found.state}${claim === undefined ? '' : `, taken by ${claim.holder} ${formatAge(claim.at)}`})`)
  console.log(found.html_url)

  if (list.length > 0)
    console.log(`\n${left.length} of ${list.length} boxes left`)

  for (const box of values.todo === true ? left : list)
    console.log(`${String(box.number).padStart(3)} [${box.done ? 'x' : ' '}] ${box.text}`)

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
