import type { Row } from './picker/state'
import type { PreviewFn, Reload } from './picker/terminal'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { CTRL_KEY } from './picker/state'
import { select } from './picker/terminal'
import { parseHeight } from './picker/view'

export { rank } from './picker/score'
export type { Ranked } from './picker/score'
export type { Row } from './picker/state'
export { choose } from './picker/terminal'
export type { PickSettings, PreviewFn, Reload, Reloaded, Selection, Terminal } from './picker/terminal'
export type { PreviewPosition } from './picker/view'
export { DEFAULT_HEIGHT, parseHeight } from './picker/view'
export type { Height } from './picker/view'

export interface PickOptions {
  prompt: string
  header?: string
  // Control keys that pick the highlighted row too, telling which one was pressed: `ctrl-d`, any ctrl-a to ctrl-z but ctrl-c, h, i, j and m.
  expect?: string[]
  // A command called with the hidden fields as `{1}`, `{2}`..., or a function of them, shown below the list.
  preview?: string | PreviewFn
  // How many leading cells are searched, so a word of a description does not outrank the name it was typed for. All of them by default.
  searched?: number
  // Whole height by default, for a list of a few candidates asked about under the command.
  height?: string
  // Replaces the rows and header in place when its key is pressed, the query kept.
  reload?: Reload | undefined
}

// The row picked with its hidden fields, none when an expected key was pressed with no row matching, and the query as it stood.
export interface Picked {
  key: string
  hidden: string[]
  query: string
}

// A row as term lists it with `--list` in place of the picker's window, in the pane's folder: what tmux_pick types back for Enter and for the picker's other keys.
export interface Listed {
  label: string
  hint: string
  // The words typed after the picker's name to find the same choice again; for a row asking for a text, the ones before it.
  typed: string
  // Set for a row asking for a text first, typed after its words: ctrl-n's new branch.
  asks?: string
  // The picker's arguments printing the row's preview, its `--show`.
  preview?: string[]
  // ctrl-e leaves the picker's name and these words on the prompt rather than the command they run.
  editsTyped?: boolean
  actions?: ListedAction[]
}

export interface ListedAction {
  label: string
  // The name of the key doing it there, `ctrl-d`.
  key: string
  typed?: string
  // The picker run with these arguments, then listed again: ctrl-r's fetch.
  reload?: string[]
}

export interface Run {
  id: string
  args: string[]
}

// A word of the command: fixed, an argument given by the user, or the name of one to prompt for; the last two are what a run is remembered with.
export type Arg = string | { given: string } | { ask: string }

const REMEMBERED = 20

// The rows as lines for a listing: the hidden fields, then every cell but the last padded to its column, tab-separated.
// Widths are measured without the color codes.
export function table(rows: Row[]): string[] {
  const widths = rows[0]?.cells.map((_, index) => Math.max(...rows.map(row => Bun.stringWidth(row.cells[index]!)))) ?? []

  return rows.map(row => [
    ...row.hidden,
    ...row.cells.map((cell, index) => (index === row.cells.length - 1 ? cell.trimEnd() : `${cell}${' '.repeat(widths[index]! + 1 - Bun.stringWidth(cell))}`)),
  ].join('\t'))
}

// Asks for one of the rows on the terminal, the picker drawn on stderr and its keys read from /dev/tty; undefined when cancelled. The shortest match wins a tie, `install` before `install-hooks`.
export async function pick(rows: Row[], options: PickOptions): Promise<Picked | undefined> {
  const height = parseHeight(options.height ?? '100%')
  const keys = [...options.expect ?? [], ...options.reload?.key === undefined ? [] : [options.reload.key]]

  if (height === undefined)
    throw new Error(`pick: the height is lines or a percentage, not ${options.height}`)

  for (const key of keys) {
    if (!CTRL_KEY.test(key))
      throw new Error(`pick: ${key} is not a key it can report, one of ctrl-a to ctrl-z but ctrl-c, h, i, j and m`)
  }

  const found = await select(rows, { multi: false, prompt: options.prompt, query: '', height, preview: options.preview, previewPosition: 'down', header: options.header, expect: options.expect, searched: options.searched, reload: options.reload })

  return found === undefined ? undefined : { key: found.key, hidden: found.rows[0]?.hidden ?? [], query: found.query }
}

// A few candidates, as tall as they need under the command with the preview below them.
export function heightFor(count: number): string {
  return String(Math.max(15, Math.ceil((count + 4) / 0.6)))
}

function historyFile(name: string): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), name, 'history.json')
}

// Keyed by folder, a broken or missing file reading as nothing run yet.
function history(name: string): Record<string, Run[]> {
  try {
    const file = historyFile(name)

    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) as Record<string, Run[]> : {}
  }
  catch {
    return {}
  }
}

export function runs(name: string): Run[] {
  return history(name)[process.cwd()] ?? []
}

export function record(name: string, run: Run): void {
  const all = history(name)
  const file = historyFile(name)

  all[process.cwd()] = [run, ...(all[process.cwd()] ?? []).filter(earlier => earlier.id !== run.id)].slice(0, REMEMBERED)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(all))
}

// The ones run last come first, most recent at the top, the rest keeping their order.
export function byRecency<T>(items: T[], previous: Run[], idOf: (item: T) => string): T[] {
  const rank = new Map(previous.map((run, index) => [run.id, index]))
  const recent = items.filter(item => rank.has(idOf(item))).sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!)

  return [...recent, ...items.filter(item => !rank.has(idOf(item)))]
}

function word(arg: Arg): string {
  if (typeof arg === 'string')
    return `=${arg}`

  return 'given' in arg ? `+${arg.given}` : `?${arg.ask}`
}

// The lines `__pick_run` and tmux_pick read: `run`, or `edit` to leave the command on the prompt; the words typed after the picker's name to find the same choice again; the id the run is called back with once the prompts are answered, or nothing; then one line per word of the command, `=fixed`, `+given` or `?name` to prompt for.
export function emit(mode: 'run' | 'edit', typed: string, recorded: string, command: Arg[]): void {
  const words = command.map(word)

  console.log([mode, typed, recorded, ...words].join('\n'))
}

// What `--list` prints, term reading it back.
export function list(rows: Listed[]): void {
  console.log(JSON.stringify(rows))
}
