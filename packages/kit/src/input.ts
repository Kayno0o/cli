import { fstatSync } from 'node:fs'
import process from 'node:process'
import { badUsage, fail } from './args'

const WHOLE = /^\d+$/

// A name written `<run id>` is a positional and is printed as is, any other is an option printed `--name`.
export function wholeNumber(value: string | undefined, name: string, fallback: number, min = 1): number {
  if (value === undefined)
    return fallback

  const number = Number(value)

  if (!WHOLE.test(value) || !Number.isSafeInteger(number) || number < min)
    badUsage(`${name.startsWith('<') ? name : `--${name}`} takes a whole number from ${min}, not ${value}`)

  return number
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|[smhd])?$/
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

// A duration such as `500ms`, `90s`, `5m`, `1h` or `7d` in milliseconds, a bare number counting in `unit`.
export function duration(value: string | undefined, name: string, fallback: number, unit: 's' | 'm' | 'h' = 's'): number {
  if (value === undefined)
    return fallback

  const match = DURATION.exec(value.trim())
  const ms = match === null ? 0 : Number(match[1]) * UNIT_MS[(match[2] ?? unit) as keyof typeof UNIT_MS]

  if (ms < 1)
    badUsage(`--${name} takes a duration such as 30s, 5m, 1h or 7d, not ${value}`)

  return ms
}

// Whether stdin is a pipe or a file to read, rather than a terminal or /dev/null that would leave a command waiting or reading nothing.
export function isStdinPiped(): boolean {
  const stat = fstatSync(0)

  return stat.isFIFO() || stat.isFile()
}

export interface InputSettings {
  // What to say when stdin is a terminal, as nothing is piped.
  noStdin?: string
}

// Text from a file, or from stdin when the path is `-`. A missing file or a stdin left on the terminal ends the command.
export async function readInput(path: string, { noStdin = 'nothing is piped on stdin' }: InputSettings = {}): Promise<string> {
  if (path === '-') {
    if (process.stdin.isTTY)
      fail(noStdin)

    return Bun.stdin.text()
  }

  const file = Bun.file(path)

  if (!await file.exists())
    fail(`no file ${path}`)

  return file.text()
}
