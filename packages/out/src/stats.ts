import { appendFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { CLI_FOLDER, stateHome, table } from '@kaynooo/cli-kit'

// A rough count, close enough for a running total: no tokenizer is shipped or called.
const BYTES_PER_TOKEN = 4
// A subcommand or script name (`run`, `build`, `test:unit`); a secret almost always holds a digit or a capital, so such a word ends the key.
const KEY_WORD = /^[a-z][a-z:_-]*$/
const KEY_WORDS = 3
const BLANKS = /\s+/
const ASSIGNMENT = /^\w+=/
const CHAIN = /&&|\|\||;/
const SHELLS = new Set(['sh', 'bash', 'zsh'])
const TOP = 10

// One run of `out`: what ran, how much it printed, how much of that the session would have read without `out` (less than all of it when `out` replaced a `| tail` or `| grep`), and how much `out` let through.
export interface Entry {
  at: string
  dir: string
  command: string
  bytes: number
  baseline: number
  shown: number
  folded: boolean
}

export function statsPath(env: Record<string, string | undefined> = process.env): string {
  return join(stateHome(env), CLI_FOLDER, 'out', 'stats.jsonl')
}

// The words naming what ran (`bun run build`, `docker compose exec`), stopping at an option or any word that could carry a value, so no argument a secret may sit in is kept; `sh -c '...'` is named by the last command of its chain that is not a `cd`.
export function commandKey(command: readonly string[]): string {
  const [program = '', ...rest] = command.slice(Math.max(0, command.findIndex(word => !ASSIGNMENT.test(word))))

  if (SHELLS.has(basename(program)) && rest[0] === '-c' && rest[1] !== undefined) {
    const chain = rest[1].split(CHAIN).map(segment => segment.trim()).filter(segment => segment !== '' && segment !== 'cd' && !segment.startsWith('cd '))

    return commandKey((chain.at(-1) ?? '').split(BLANKS))
  }

  const words = [basename(program)]

  for (const word of rest) {
    if (words.length === KEY_WORDS || !KEY_WORD.test(word))
      break

    words.push(word)
  }

  return words.join(' ')
}

// Appends the run to the stats, best effort: a stats file that cannot be written never changes what `out` prints or exits with.
export function record(entry: Entry, path = statsPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }
  catch {}
}

export async function readEntries(path = statsPath(), since = 0): Promise<Entry[]> {
  const file = Bun.file(path)

  if (!await file.exists())
    return []

  return (await file.text()).split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Entry

      return Date.parse(entry.at) >= since ? [entry] : []
    }
    catch {
      return []
    }
  })
}

export interface Summary {
  runs: number
  folded: number
  bytes: number
  shown: number
  tokensSaved: number
  // The share of runs folded, in percent.
  foldedShare: number
  // The median share of its baseline a folded run cut, in percent per command; undefined when none folded.
  commands: { command: string, runs: number, folded: number, tokensSaved: number, medianCut?: number | undefined }[]
}

function median(values: number[]): number | undefined {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  if (sorted.length === 0)
    return undefined

  return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

function tokens(bytes: number): number {
  return Math.round(bytes / BYTES_PER_TOKEN)
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

function cut(runs: readonly Entry[]): number | undefined {
  const value = median(runs.filter(run => run.folded && run.baseline > 0).map(run => (1 - run.shown / run.baseline) * 100))

  return value === undefined ? undefined : Math.round(value)
}

export function summarize(entries: readonly Entry[]): Summary {
  const commands = Map.groupBy(entries, entry => entry.command).entries().map(([command, runs]) => ({
    command,
    runs: runs.length,
    folded: runs.filter(run => run.folded).length,
    tokensSaved: tokens(runs.reduce((sum, run) => sum + run.baseline - run.shown, 0)),
    medianCut: cut(runs),
  }))
  const sum = (field: 'bytes' | 'baseline' | 'shown') => entries.reduce((total, entry) => total + entry[field], 0)

  return { runs: entries.length, folded: entries.filter(entry => entry.folded).length, bytes: sum('bytes'), shown: sum('shown'), tokensSaved: tokens(sum('baseline') - sum('shown')), foldedShare: entries.length === 0 ? 0 : Math.round(entries.filter(entry => entry.folded).length / entries.length * 100), commands: [...commands].sort((a, b) => b.tokensSaved - a.tokensSaved) }
}

export function renderSummary(summary: Summary, period: string): string {
  if (summary.runs === 0)
    return `no run of out recorded ${period}`

  const top = summary.commands.slice(0, TOP).filter(each => each.tokensSaved !== 0)

  return [
    `${formatNumber(summary.runs)} runs ${period}, ${formatNumber(summary.folded)} folded (${summary.foldedShare}%): ${formatNumber(summary.bytes)} bytes printed, ${formatNumber(summary.shown)} shown, about ${formatNumber(summary.tokensSaved)} tokens saved (bytes / ${BYTES_PER_TOKEN})`,
    ...top.length === 0 ? [] : ['', table([['command', 'runs', 'folded', 'median cut', 'tokens saved'], ...top.map(each => [each.command, formatNumber(each.runs), formatNumber(each.folded), each.medianCut === undefined ? '-' : `${each.medianCut}%`, formatNumber(each.tokensSaved)])])],
  ].join('\n')
}
