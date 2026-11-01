import type { ParseArgsOptionDescriptor } from 'node:util'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { upTo } from './format'
import { paint } from './style'

export type Options = Record<string, ParseArgsOptionDescriptor & { description: string }>

// Thrown to end a command with this exit code and message, which runCli prints as `error: <cli> <command>: <message>`, the hint on a line of its own.
export class Exit extends Error {
  constructor(message: string, readonly code: number, readonly hint?: string) {
    super(message)
  }
}

export function fail(message: string, code = 2, hint?: string): never {
  throw new Exit(message, code, hint)
}

// An Exit for arguments the command cannot take, which runCli points at the command's --help.
export class UsageError extends Exit {
  constructor(message: string) {
    super(message, 2)
  }
}

export function badUsage(message: string): never {
  throw new UsageError(message)
}

// Thrown by parse while a bin answers `__complete`, so the command reached hands over its options before doing anything else.
export class Completing {
  constructor(readonly options: Options) {}
}

export const completion = { active: false }

// Optional parts of a usage line, `[options]` or `[tag]`, dimmed in the help.
const OPTIONAL = /\[[^\]]+\]/g
const USAGE_PREFIX = /^usage:\s*/i

// `Usage: <usage>`, the usage given with or without its own `usage:`, optional parts dimmed.
export function usageLine(usage: string, colors = paint(process.stdout)): string {
  return `${colors.bold('Usage:')} ${usage.replace(USAGE_PREFIX, '').replaceAll(OPTIONAL, part => colors.dim(part))}`
}

export function helpText(usage: string, options: Options, colors = paint(process.stdout)): string {
  const rows = Object.entries(options).map(([name, option]) => {
    const short = option.short === undefined ? '    ' : `${colors.cyan(`-${option.short}`)}, `
    const value = option.type === 'string' ? ` ${colors.dim('<value>')}` : ''

    return { flag: `${short}${colors.cyan(`--${name}`)}${value}`, width: `-x, --${name}`.length + (option.type === 'string' ? ' <value>'.length : 0), description: option.description }
  })
  const width = Math.max(0, ...rows.map(row => row.width))

  return [usageLine(usage, colors), '', colors.bold('Options:'), ...rows.map(row => `  ${row.flag}${' '.repeat(width - row.width)}  ${colors.dim(row.description)}`)].join('\n')
}

export interface ParseSettings {
  // Stops at the first `--` and hands what follows back untouched as `rest`, for a command that runs another (`out -n 200 -- <cmd>`).
  rest?: boolean
  // Takes `--no-<flag>` as `false` for a boolean flag, as parseArgs' own `allowNegative` does.
  allowNegative?: boolean
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
    parsed = parseArgs({ args: own, options: all, allowPositionals: true, allowNegative: settings.allowNegative === true, strict: true })
  }
  catch (error) {
    badUsage(parseError(error))
  }

  if ((parsed.values as { help?: boolean }).help === true) {
    console.log(helpText(usage, all))

    return undefined
  }

  return { ...parsed, rest }
}

// parseArgs' message, its first sentence alone and lowercased as the kit's own: `unknown option '--nope'`.
function parseError(error: unknown): string {
  const message = upTo(error instanceof Error ? error.message : String(error), '. ')

  return `${message.charAt(0).toLowerCase()}${message.slice(1)}`
}

export function wholeNumber(value: string | undefined, name: string, fallback: number, min = 1): number {
  if (value === undefined)
    return fallback

  const number = Number(value)

  if (!Number.isInteger(number) || number < min)
    badUsage(`--${name} takes a whole number from ${min}, not ${value}`)

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
    badUsage(`--${name} takes a duration such as 30s, 5m or 1h, not ${value}`)

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
