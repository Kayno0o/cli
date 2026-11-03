import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

export interface Run {
  id: string
  args: string[]
}

const REMEMBERED = 20

function historyFile(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dx', 'history.json')
}

// Keyed by folder, a broken or missing file reading as nothing run yet.
function history(): Record<string, Run[]> {
  try {
    const file = historyFile()

    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) as Record<string, Run[]> : {}
  }
  catch {
    return {}
  }
}

export function runs(): Run[] {
  return history()[process.cwd()] ?? []
}

export function record(run: Run): void {
  const all = history()
  const file = historyFile()

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
