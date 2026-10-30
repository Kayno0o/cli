import type { ParseArgsOptionDescriptor } from 'node:util'
import process from 'node:process'
import { parseArgs } from 'node:util'

export type Options = Record<string, ParseArgsOptionDescriptor & { description: string }>

// Thrown to end a command with this exit code and message, which runCli prints as `<cli> <command>: <message>`.
export class Exit extends Error {
  constructor(message: string, readonly code: number) {
    super(message)
  }
}

export function fail(message: string, code = 2): never {
  throw new Exit(message, code)
}

// Thrown by parse while a bin answers `__complete`, so the command reached hands over its options before doing anything else.
export class Completing {
  constructor(readonly options: Options) {}
}

export const completion = { active: false }

export function helpText(usage: string, options: Options): string {
  const rows = Object.entries(options).map(([name, option]) => [`${option.short === undefined ? '    ' : `-${option.short}, `}--${name}${option.type === 'string' ? ' <value>' : ''}`, option.description] as const)
  const width = Math.max(0, ...rows.map(([flag]) => flag.length))

  return [usage, '', ...rows.map(([flag, description]) => `  ${flag.padEnd(width)}  ${description}`)].join('\n')
}

export interface ParseSettings {
  // Stops at the first `--` and hands what follows back untouched as `rest`, for a command that runs another (`out -n 200 -- <cmd>`).
  rest?: boolean
}

// Parses a command's arguments, printing its help and returning undefined on --help.
export function parse<const T extends Options>(args: string[], usage: string, options: T, settings: ParseSettings = {}) {
  const all = { ...options, help: { type: 'boolean', short: 'h', description: 'show this help' } } as const

  if (completion.active)
    throw new Completing(all)

  const separator = settings.rest === true ? args.indexOf('--') : -1
  const own = separator === -1 ? args : args.slice(0, separator)
  const rest = separator === -1 ? undefined : args.slice(separator + 1)

  let parsed

  try {
    parsed = parseArgs({ args: own, options: all, allowPositionals: true, strict: true })
  }
  catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${helpText(usage, all)}`)
  }

  if ((parsed.values as { help?: boolean }).help === true) {
    console.log(helpText(usage, all))

    return undefined
  }

  return { ...parsed, rest }
}

export function wholeNumber(value: string | undefined, name: string, fallback: number, min = 1): number {
  if (value === undefined)
    return fallback

  const number = Number(value)

  if (!Number.isInteger(number) || number < min)
    fail(`--${name} takes a whole number from ${min}, not ${value}`)

  return number
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|[smh])?$/
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const

// A duration such as `500ms`, `90s`, `5m` or `1h` in milliseconds, a bare number counting in `unit`.
export function duration(value: string | undefined, name: string, fallback: number, unit: 's' | 'm' = 's'): number {
  if (value === undefined)
    return fallback

  const match = DURATION.exec(value.trim())
  const ms = match === null ? 0 : Number(match[1]) * UNIT_MS[(match[2] ?? unit) as keyof typeof UNIT_MS]

  if (ms < 1)
    fail(`--${name} takes a duration such as 30s, 5m or 1h, not ${value}`)

  return ms
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
