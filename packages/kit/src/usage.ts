import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
}

const UNKNOWN_OPTION = /unknown option '(-[\w-]+)/
const LONGEST_NAME = 40

// Set when a run reported a usage error, so the entry of that run can name the option.
let usageError: string | undefined

export function noteUsageError(message: string): void {
  usageError = message
}

export function usagePath(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), CLI_FOLDER, 'usage.jsonl')
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

  return [...new Set(names)].filter(name => name.length <= LONGEST_NAME)
}

// The entry for a run that exited with `code`, with the unknown option a usage error named.
export function usageEntry(bin: string, command: string | undefined, argv: readonly string[], code: number, now = new Date()): UsageEntry {
  const unknown = code === 2 && usageError !== undefined ? UNKNOWN_OPTION.exec(usageError)?.[1] : undefined

  usageError = undefined

  return { at: now.toISOString(), bin, ...(command === undefined ? {} : { command }), flags: flagNames(argv), code, ...(unknown === undefined ? {} : { unknown }) }
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

export interface UsageSummary {
  runs: number
  bins: { bin: string, runs: number, failed: number, usageErrors: number }[]
  usageErrors: { bin: string, command?: string, unknown: string, count: number }[]
}

// Runs per bin, and the usage errors by the option that was not known, most common first.
export function summarizeUsage(entries: readonly UsageEntry[]): UsageSummary {
  const bins = new Map<string, { runs: number, failed: number, usageErrors: number }>()
  const errors = new Map<string, { bin: string, command?: string, unknown: string, count: number }>()

  for (const entry of entries) {
    const bin = bins.get(entry.bin) ?? { runs: 0, failed: 0, usageErrors: 0 }

    bin.runs++
    bin.failed += entry.code === 0 ? 0 : 1
    bin.usageErrors += entry.code === 2 ? 1 : 0
    bins.set(entry.bin, bin)

    if (entry.code === 2 && entry.unknown !== undefined) {
      const key = `${entry.bin} ${entry.command ?? ''} ${entry.unknown}`
      const error = errors.get(key) ?? { bin: entry.bin, ...(entry.command === undefined ? {} : { command: entry.command }), unknown: entry.unknown, count: 0 }

      error.count++
      errors.set(key, error)
    }
  }

  return {
    runs: entries.length,
    bins: [...bins].map(([bin, counts]) => ({ bin, ...counts })).toSorted((a, b) => b.runs - a.runs),
    usageErrors: [...errors.values()].toSorted((a, b) => b.count - a.count),
  }
}
