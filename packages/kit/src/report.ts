import type { Mark } from './theme'
import process from 'node:process'
import { printError } from './cli'
import { marked, paint, role, section } from './style'
import { closest } from './text'

interface Stream { isTTY?: boolean, columns?: number }
type Env = Record<string, string | undefined>

export type ChangeKind = 'add' | 'remove' | 'change'

export interface Change {
  kind: ChangeKind
  label: string
  detail?: string
}

const CHANGE_MARKS: Record<ChangeKind, { sign: string, tone: Mark }> = {
  add: { sign: '+', tone: 'ok' },
  remove: { sign: '-', tone: 'problem' },
  change: { sign: '~', tone: 'warn' },
}

// `+ users.email` in green, `- users.legacy` in red, `~ users.name  text → varchar` in yellow, the detail dimmed; the same signs uncoloured elsewhere.
export function changeLines(changes: Change[], stream: Stream = process.stdout, env: Env = process.env): string[] {
  const dim = paint(stream, env).dim

  return changes.map(({ kind, label, detail }) => {
    const { sign, tone } = CHANGE_MARKS[kind]

    return `${role(tone, stream, env)(sign)} ${label}${detail === undefined ? '' : `  ${dim(detail)}`}`
  })
}

// A `section()` titled `title` with the number of changes, then one line each; `none` printed instead when there are none.
export function printChanges(title: string, changes: Change[], none = 'nothing to change', stream: Stream = process.stdout, env: Env = process.env): void {
  if (changes.length === 0) {
    console.log(marked('note', none, stream, undefined, env))

    return
  }

  console.log(section(title, changes.length, stream, env))

  for (const line of changeLines(changes, stream, env))
    console.log(line)
}

// `◇ would create alice (admin)` on a terminal, `would: create alice (admin)` elsewhere: what a dry run says it would do.
export function planned(text: string, detail?: string, stream: Stream = process.stdout, env: Env = process.env): string {
  return marked('plan', text, stream, detail, env)
}

export function printPlanned(text: string, detail?: string): void {
  console.log(planned(text, detail))
}

// `did you mean alice?` for a name close to a known one, `one of: a, b, c` (at most `limit`, then the count left) otherwise.
export function unknownHint(name: string, known: string[], limit = 8): string | undefined {
  const meant = closest(name, known)

  if (meant !== undefined)
    return `did you mean ${meant}?`

  if (known.length === 0)
    return undefined

  const shown = known.slice(0, limit)

  return `one of: ${shown.join(', ')}${known.length > limit ? ` and ${known.length - limit} more` : ''}`
}

// `error <prefix>: no <kind> <name>` with the `unknownHint` under it.
export function printUnknown(prefix: string, kind: string, name: string, known: string[]): void {
  printError(prefix, `no ${kind} ${name}`, unknownHint(name, known))
}
