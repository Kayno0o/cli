import type { ExitRow } from '@kaynooo/cli-kit'
import type { Mark } from './todo'
import { join } from 'node:path'
import process from 'node:process'
import { capped, duration, jsonOption, limitOf, limitOptions, parse, printJson, warn } from '@kaynooo/cli-kit'
import { listFiles, readText } from './files'
import { addAges, lookUp, marksIn, refKey } from './todo'

const USAGE = `src todo-scan [options] [path...]: lists the TODO, FIXME, HACK, XXX and owner/repo#N comments under the paths (here by default), each as <file>:<line>: <comment>, honouring .gitignore

--older <duration> keeps only the comments whose line last changed longer ago than that (30d, 12w, 6m: git blame dates each one, a file git cannot blame is left out) and shows each one's age.

--stale keeps only the comments naming a closed issue, each issue's state looked up with ft, or gh for a GitHub repository, and exits 1 when it finds one.

Lists at most 100 comments, the count of the rest after them (--limit <n>, --full for all); --json is never cut unless --limit is given.`
const EXITS: ExitRow[] = [[0, 'it listed the comments or found no stale one'], [1, '--stale finds one'], [2, 'a usage error or when --stale could not look a repository up (ft and gh both failed)']]

const LIST_LIMIT = 100
const DAY_MS = 86_400_000

const OPTIONS = {
  stale: { type: 'boolean', description: 'only the comments naming a closed issue, looked up with ft or gh' },
  older: { type: 'string', description: 'only the comments whose line last changed longer ago than this duration, from git blame' },
  ...limitOptions(LIST_LIMIT),
  json: jsonOption('[{path, line, kind, text, refs: [{repo, number, state?}], age?}], age being the days since the line last changed, given with --older or --json when git can date it'),
} as const

function printLines(lines: string[], footer: string | undefined): void {
  const all = [...lines, ...footer === undefined ? [] : [footer]]

  if (all.length > 0)
    console.log(all.join('\n'))
}

export async function todoScan(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, USAGE, OPTIONS, { exits: EXITS, positionals: ['[path...]'], replaces: 'grep -rn TODO, then opening each issue it names', examples: ['src todo-scan src', ['src todo-scan --stale', 'only the comments naming a closed issue']] })
  const cwd = process.cwd()
  const limit = limitOf(values, LIST_LIMIT)
  const found: Mark[] = []

  for (const path of await listFiles(positionals, cwd)) {
    const text = await readText(join(cwd, path))

    if (text !== undefined)
      found.push(...marksIn(text, path))
  }

  const older = values.older === undefined ? undefined : duration(values.older, 'older', 0, 'm') / DAY_MS
  let marks = found

  if (older !== undefined || values.json === true)
    await addAges(found, cwd)

  // The age shown after a comment, only when --older asked for it.
  const ageNote = (mark: Mark) => older === undefined || mark.age === undefined ? '' : ` [${mark.age}d]`

  if (older !== undefined)
    marks = found.filter(mark => mark.age !== undefined && mark.age >= older)

  if (values.stale !== true) {
    const { shown, footer } = capped(marks, limit)

    if (values.json === true)
      printJson(shown)
    else
      printLines(shown.map(mark => `${mark.path}:${mark.line}: ${mark.text}${ageNote(mark)}`), footer)

    return 0
  }

  const { states, failed } = await lookUp(marks.flatMap(mark => mark.refs), cwd)

  for (const [repo, reason] of failed)
    warn(`could not look ${repo} up`, reason)

  const stale = marks.filter(mark => mark.refs.some(ref => states.get(refKey(ref)) === 'closed'))

  const { shown, footer } = capped(stale, limit)

  if (values.json === true)
    printJson(shown.map(mark => ({ ...mark, refs: mark.refs.map(ref => ({ ...ref, state: states.get(refKey(ref)) })) })))
  else
    printLines(shown.map(mark => `${mark.path}:${mark.line}: ${mark.refs.filter(ref => states.get(refKey(ref)) === 'closed').map(refKey).join(', ')} closed: ${mark.text}${ageNote(mark)}`), footer)

  if (stale.length > 0)
    return 1

  return failed.size > 0 ? 2 : 0
}
