import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { CLI_FOLDER } from './logs'

// One run of a bin: which command it ran, the names of the flags it saw (never a value or an argument), how it exited and, on a usage error, the option it did not know.
export interface UsageEntry {
  at: string
  bin: string
  command?: string
  flags: string[]
  code: number
  unknown?: string
  // How long the run took, in whole milliseconds.
  ms?: number
}

const UNKNOWN_OPTION = /unknown option '(--[a-z][a-z0-9-]*)[=']/
// A long name, or a single letter: anything else is an argument that happens to start with a dash, such as `-secret`.
const FLAG_NAME = /^(?:--[a-z][a-z0-9-]*|-[a-zA-Z])$/
const LONGEST_NAME = 40

// Set when a run reported a usage error, so the entry of that run can name the option.
let usageError: string | undefined

export function noteUsageError(message: string): void {
  usageError = message
}

// XDG_STATE_HOME when it is an absolute path, else ~/.local/state, as the spec says an empty or relative value is ignored.
export function stateHome(env: Record<string, string | undefined> = process.env): string {
  const dir = env.XDG_STATE_HOME

  return dir !== undefined && isAbsolute(dir) ? dir : join(homedir(), '.local', 'state')
}

export function usagePath(env: Record<string, string | undefined> = process.env): string {
  return join(stateHome(env), CLI_FOLDER, 'usage.jsonl')
}

// Whether runs are recorded: never under `bun test`, and not once KAYNOOO_CLI_NO_USAGE is set to anything but 0 or an empty value.
export function usageRecorded(env: Record<string, string | undefined> = process.env): boolean {
  const off = env.KAYNOOO_CLI_NO_USAGE

  return env.NODE_ENV !== 'test' && (off === undefined || off === '' || off === '0')
}

// The flags among the arguments by name, `--limit=5` as `--limit`, stopping at `--`.
export function flagNames(argv: readonly string[]): string[] {
  const end = argv.indexOf('--')
  const names = (end === -1 ? argv : argv.slice(0, end)).filter(word => word.startsWith('-') && word !== '-').map(word => word.includes('=') ? word.slice(0, word.indexOf('=')) : word)

  return [...new Set(names)].filter(name => name.length <= LONGEST_NAME && FLAG_NAME.test(name))
}

// The entry for a run that exited with `code`, with the unknown option a usage error named. Only that option's name is kept, never the message, which most usage errors fill with the value they refused.
export function usageEntry(bin: string, command: string | undefined, argv: readonly string[], code: number, { ms, now = new Date() }: { ms?: number, now?: Date } = {}): UsageEntry {
  const unknown = code === 2 && usageError !== undefined ? UNKNOWN_OPTION.exec(usageError)?.[1] : undefined

  usageError = undefined

  return { at: now.toISOString(), bin, ...(command === undefined ? {} : { command }), flags: flagNames(argv), code, ...(unknown === undefined ? {} : { unknown }), ...(ms === undefined ? {} : { ms: Math.round(ms) }) }
}

// Appends the run to the usage log, best effort: a log that cannot be written never changes what a bin prints or exits with.
export function recordUsage(entry: UsageEntry, env: Record<string, string | undefined> = process.env): void {
  if (!usageRecorded(env))
    return

  try {
    const path = usagePath(env)

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }
  catch {}
}

export async function readUsage(path = usagePath(), since = 0): Promise<UsageEntry[]> {
  const file = Bun.file(path)

  if (!await file.exists())
    return []

  return (await file.text()).split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as UsageEntry

      return Date.parse(entry.at) >= since ? [entry] : []
    }
    catch {
      return []
    }
  })
}

// `failed` counts exit codes other than 0 and 2 (the run happened and did not succeed), `usageErrors` exit 2 (the run could not check or was misused).
export interface UsageCounts { runs: number, failed: number, usageErrors: number }

export interface UsageSummary {
  runs: number
  bins: ({ bin: string } & UsageCounts)[]
  commands: ({ bin: string, command: string } & UsageCounts)[]
  usageErrors: { bin: string, command?: string, unknown: string, count: number }[]
  // Per command (the bin alone for a single-command one), how long its timed runs took, slowest p90 first; a usage error is left out.
  durations: { bin: string, command?: string, runs: number, median: number, p90: number }[]
}

// The value below which `share` of the sorted values fall, nearest rank.
function percentile(sorted: readonly number[], share: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] ?? 0
}

function tally(counts: UsageCounts, code: number): void {
  counts.runs++
  counts.failed += code === 0 || code === 2 ? 0 : 1
  counts.usageErrors += code === 2 ? 1 : 0
}

// Runs per bin and per command, and the usage errors by the option that was not known, most common first.
export function summarizeUsage(entries: readonly UsageEntry[]): UsageSummary {
  const bins = new Map<string, UsageCounts>()
  const commands = new Map<string, { bin: string, command: string } & UsageCounts>()
  const unknowns = new Map<string, { bin: string, command?: string, unknown: string, count: number }>()
  const timed = new Map<string, { bin: string, command?: string, ms: number[] }>()

  for (const entry of entries) {
    if (entry.ms !== undefined && entry.code !== 2) {
      const key = `${entry.bin} ${entry.command ?? ''}`
      const times = timed.get(key) ?? { bin: entry.bin, ...entry.command === undefined ? {} : { command: entry.command }, ms: [] }

      times.ms.push(entry.ms)
      timed.set(key, times)
    }

    const bin = bins.get(entry.bin) ?? { runs: 0, failed: 0, usageErrors: 0 }

    tally(bin, entry.code)
    bins.set(entry.bin, bin)

    if (entry.command !== undefined) {
      const command = commands.get(`${entry.bin} ${entry.command}`) ?? { bin: entry.bin, command: entry.command, runs: 0, failed: 0, usageErrors: 0 }

      tally(command, entry.code)
      commands.set(`${entry.bin} ${entry.command}`, command)
    }

    if (entry.code !== 2)
      continue

    if (entry.unknown !== undefined) {
      const key = `${entry.bin} ${entry.command ?? ''} ${entry.unknown}`
      const unknown = unknowns.get(key) ?? { bin: entry.bin, ...entry.command === undefined ? {} : { command: entry.command }, unknown: entry.unknown, count: 0 }

      unknown.count++
      unknowns.set(key, unknown)
    }
  }

  return {
    runs: entries.length,
    bins: [...bins].map(([bin, counts]) => ({ bin, ...counts })).toSorted((a, b) => b.runs - a.runs),
    commands: [...commands.values()].toSorted((a, b) => b.runs - a.runs),
    usageErrors: [...unknowns.values()].toSorted((a, b) => b.count - a.count),
    durations: [...timed.values()].map(({ ms, ...name }) => {
      const sorted = ms.toSorted((a, b) => a - b)

      return { ...name, runs: sorted.length, median: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) }
    }).toSorted((a, b) => b.p90 - a.p90),
  }
}
