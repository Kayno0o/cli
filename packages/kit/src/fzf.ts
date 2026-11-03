import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

export interface Row {
  hidden: string[]
  cells: string[]
}

export interface FzfOptions {
  prompt: string
  header?: string
  // Keys that pick the highlighted row too, telling which one was pressed.
  expect?: string[]
  // Called with the hidden fields as `{1}`, `{2}`...
  preview?: string
  // How many leading cells are searched, so a word of a description does not outrank the name it was typed for.
  searched: number
  // Whole height by default, for a list of a few candidates asked about under the command.
  height?: string
  bind?: string[]
  // How many leading fields are hidden, taken from the first row by default, which a list that starts empty and reloads has none of.
  hidden?: number
  // The query comes back too, and an expected key pressed with no row matching still picks, with no hidden fields.
  query?: boolean
}

export interface Picked {
  key: string
  hidden: string[]
  query: string
}

// A row as term lists it with `--list` in place of the fzf window, in the pane's folder: what tmux_pick types back for Enter and for the picker's other keys.
export interface Listed {
  label: string
  hint: string
  // The words typed after the picker's name to find the same choice again; for a row asking for a text, the ones before it.
  typed: string
  // Set for a row asking for a text first, typed after its words: ctrl-n's new branch.
  asks?: string
  // The picker's arguments printing the row's preview, its `--show` as fzf calls it.
  preview?: string[]
  // ctrl-e leaves the picker's name and these words on the prompt rather than the command they run.
  editsTyped?: boolean
  actions?: ListedAction[]
}

export interface ListedAction {
  label: string
  // fzf's name for the key doing it there.
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

// Every cell but the last padded to its column, one space short of the two between columns since a tab renders as one, see `--tabstop`.
// Widths are measured without the color codes.
export function table(rows: Row[]): string[] {
  const widths = rows[0]?.cells.map((_, index) => Math.max(...rows.map(row => Bun.stringWidth(row.cells[index]!)))) ?? []

  return rows.map(row => [
    ...row.hidden,
    ...row.cells.map((cell, index) => (index === row.cells.length - 1 ? cell.trimEnd() : `${cell}${' '.repeat(widths[index]! + 1 - Bun.stringWidth(cell))}`)),
  ].join('\t'))
}

export function fzf(rows: Row[], options: FzfOptions): Picked | undefined {
  const hidden = options.hidden ?? rows[0]?.hidden.length ?? 0
  const proc = Bun.spawnSync([
    'fzf',
    '--prompt',
    options.prompt,
    ...options.header === undefined ? [] : ['--header', options.header],
    ...(options.expect ?? []).length > 0 ? ['--expect', (options.expect ?? []).join(',')] : [],
    '--ansi',
    '--reverse',
    '--height',
    options.height ?? '100%',
    '--delimiter',
    '\t',
    '--with-nth',
    `${hidden + 1}..`,
    '--nth',
    `1..${options.searched}`,
    '--tabstop',
    '1',
    // The shortest word holding the match wins a tie, `install` before `install-hooks`, where the default length would count the description too.
    '--tiebreak',
    'chunk,index',
    ...options.preview === undefined ? [] : ['--preview', options.preview, '--preview-window', 'down,40%'],
    ...(options.bind ?? []).flatMap(bind => ['--bind', bind]),
    ...options.query === true ? ['--print-query'] : [],
  ], {
    stdin: new TextEncoder().encode(table(rows).join('\n')),
    stdout: 'pipe',
    stderr: 'inherit',
  })

  return picked(proc.stdout.toString(), hidden, options)
}

// What fzf printed: the query when asked for, the key when keys are expected, then the line picked.
export function picked(output: string, hidden: number, options: Pick<FzfOptions, 'expect' | 'query'>): Picked | undefined {
  const lines = output.split('\n')
  const query = options.query === true ? lines.shift()! : ''
  const [key, line] = (options.expect ?? []).length > 0 ? [lines[0]!, lines[1]] : ['', lines[0]]

  if (line !== undefined && line !== '')
    return { key, hidden: line.split('\t').slice(0, hidden), query }

  return options.query === true && key !== '' ? { key, hidden: [], query } : undefined
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
