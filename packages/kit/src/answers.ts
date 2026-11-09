import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cacheFolder } from './folders'

// Answers kept per prompt, the oldest dropped past this.
const KEPT = 50

function answersFile(): string {
  return join(cacheFolder(), 'kaynooo-cli', 'answers.json')
}

// Every prompt's answers by key, a broken or missing file, or a key holding anything but a list of texts, reading as none given yet.
function stored(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(answersFile(), 'utf-8'))

    if (typeof parsed !== 'object' || parsed === null)
      return {}

    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(answer => typeof answer === 'string')))
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
