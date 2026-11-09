import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

// Answers kept per prompt, the oldest dropped past this.
const KEPT = 50

function answersFile(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'kaynooo-cli', 'answers.json')
}

// Every prompt's answers by key, a broken or missing file reading as none given yet.
function stored(): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(answersFile(), 'utf-8')) as Record<string, string[]>
  }
  catch {
    return {}
  }
}

// The answers given to the prompt keyed `key`, newest first.
export function earlierAnswers(key: string): string[] {
  return stored()[key] ?? []
}

// Puts `answer` first among the prompt's answers, an earlier copy of it moved rather than kept twice; a cache that cannot be written loses it.
export function rememberAnswer(key: string, answer: string): void {
  const all = stored()
  const file = answersFile()

  all[key] = [answer, ...(all[key] ?? []).filter(earlier => earlier !== answer)].slice(0, KEPT)

  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(all))
  }
  catch {}
}
