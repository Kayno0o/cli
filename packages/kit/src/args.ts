import type { ParseArgsOptionDescriptor } from 'node:util'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { upTo } from './format'
import { paint } from './style'

export type Options = Record<string, ParseArgsOptionDescriptor & { description: string }>

// The `--json` flag every CLI words alike: `print JSON`, then what it holds when given.
export function jsonOption(holds?: string) {
  return { type: 'boolean', description: holds === undefined ? 'print JSON' : `print JSON: ${holds}` } as const
}

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

// Thrown by parse once it has printed --help, so the command stops there; runCli and runMain end on it with exit 0, printing nothing more.
export class HelpShown extends Exit {
  constructor() {
    super('help shown', 0)
  }
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
  return [usageLine(usage, colors), '', colors.bold('Options:'), ...optionRows(options, colors)].join('\n')
}

// A line per option, `-n, --times <value>  how many`, aligned on the visible text.
export function optionRows(options: Options, colors = paint(process.stdout)): string[] {
  const rows = Object.entries(options).map(([name, option]) => {
    const short = option.short === undefined ? '    ' : `${colors.cyan(`-${option.short}`)}, `
    const value = option.type === 'string' ? ` ${colors.dim('<value>')}` : ''

    return { flag: `${short}${colors.cyan(`--${name}`)}${value}`, width: `-x, --${name}`.length + (option.type === 'string' ? ' <value>'.length : 0), description: option.description }
  })
  const width = Math.max(0, ...rows.map(row => row.width))

  return rows.map(row => `  ${row.flag}${' '.repeat(width - row.width)}  ${colors.dim(row.description)}`)
}

// The positionals typed by their names: `<key>` or `KEY` a string, `[file]` an optional one, a name ending in `...` the rest.
type Slots<Names extends readonly string[]> = Names extends readonly [infer First extends string, ...infer Others extends readonly string[]]
  ? First extends `${string}...` | `${string}...]` ? string[] : First extends `[${string}` ? [string?, ...Slots<Others>] : [string, ...Slots<Others>]
  : Names extends readonly [] ? [] : string[]

export interface ParseSettings<Names extends readonly string[] = string[]> {
  // Stops at the first `--` and hands what follows back untouched as `rest`, for a command that runs another (`out -n 200 -- <cmd>`).
  rest?: boolean
  // Takes `--no-<flag>` as `false` for a boolean flag, as parseArgs' own `allowNegative` does.
  allowNegative?: boolean
  // The positionals the command takes, by name as its usage writes them: `<key>` or `KEY` required, `[file]` optional, a last one ending in `...` taking any more. One missing or one too many is a usage error, and the positionals come back typed by these names.
  positionals?: Names
}

// Parses a command's arguments; on --help, prints its help and throws HelpShown, which ends the command with exit 0.
export function parse<const T extends Options, const Names extends readonly string[] = string[]>(args: string[], usage: string, options: T, settings: ParseSettings<Names> = {}) {
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

    throw new HelpShown()
  }

  if (settings.positionals !== undefined)
    checkPositionals(parsed.positionals, settings.positionals)

  return { ...parsed, positionals: parsed.positionals as Slots<Names>, rest }
}

function checkPositionals(given: string[], names: readonly string[]): void {
  const variadic = names.at(-1)?.replace(']', '').endsWith('...') === true
  const required = names.filter(name => !name.startsWith('[')).length

  if (given.length < required)
    badUsage(`missing ${names[given.length]}`)

  if (!variadic && given.length > names.length)
    badUsage(`unexpected argument ${given[names.length]}`)
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
