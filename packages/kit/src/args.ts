import type { ParseArgsOptionDescriptor } from 'node:util'
import { fstatSync } from 'node:fs'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { upTo } from './format'
import { paint } from './style'
import { closest } from './text'

interface OptionExtras {
  description?: string
  // A string option taking `choices` accepts only those values: another is a usage error naming them, the help shows them as the value and `__complete` offers them.
  choices?: readonly string[]
  // The values a string option can take, from a function, offered by `__complete` when `choices` does not give them.
  candidates?: Candidates
  // A string option whose value may be left out (`--out [n]`): bare, it reads `bare`. A next word is its value unless it starts with a dash or, given `accepts`, does not match it, and then stays a positional.
  optional?: { bare: string, accepts?: RegExp }
  // Options it cannot be given with, a usage error naming both when they are.
  conflicts?: readonly string[]
  // With `allowNegative`, a boolean option's `--no-<name>` as the help and `__complete` list it, with this description; the positive flag is then left out of both unless it has a `description` of its own, for a flag that defaults on.
  negative?: string
}

export type Options = Record<string, ParseArgsOptionDescriptor & OptionExtras>

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
  constructor(message: string, hint?: string) {
    super(message, 2, hint)
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
  constructor(readonly options: Options, readonly positionals: readonly string[] = [], readonly candidates: Record<string, Candidates | undefined> = {}) {}
}

// A value `__complete` offers, with an optional description shown beside it.
export type Candidate = string | [value: string, description: string]

// The values a positional or an option can take, read only while a shell completes it.
export type Candidates = () => Candidate[] | Promise<Candidate[]>

export const completion = { active: false }

// Optional parts of a usage line, `[options]` or `[tag]`, dimmed in the help.
const OPTIONAL = /\[[^\]]+\]/g
const USAGE_PREFIX = /^usage:\s*/i
const FULL_STOP = /\.$/
const DASHES = /^-+/

// `Usage: <usage>`, the usage given with or without its own `usage:`, optional parts dimmed.
export function usageLine(usage: string, colors = paint(process.stdout)): string {
  return `${colors.bold('Usage:')} ${usage.replace(USAGE_PREFIX, '').replaceAll(OPTIONAL, part => colors.dim(part))}`
}

export function helpText(usage: string, options: Options, colors = paint(process.stdout), { examples = [], replaces }: Described = {}): string {
  return [usageLine(usage, colors), ...replacesRows(replaces, colors), '', colors.bold('Options:'), ...optionRows(options, colors), ...exampleRows(examples, colors)].join('\n')
}

// An `Instead of:` line, after a blank line; nothing without one.
export function replacesRows(replaces: string | undefined, colors = paint(process.stdout)): string[] {
  return replaces === undefined ? [] : ['', `${colors.bold('Instead of:')} ${replaces}`]
}

// What a bin's --help prints under KIT_HELP=json, for `cli list` to read without parsing the text.
export interface Description {
  synopsis: string
  summary: string
  replaces?: string
  examples: { line: string, note?: string }[]
}

export function wantsHelpJson(env: Record<string, string | undefined> = process.env): boolean {
  return env.KIT_HELP === 'json'
}

// The synopsis and the summary a usage's first line splits into at its first `: `, else the first line after the synopses as the summary, with the examples spelled out.
export function description(usage: string, { examples = [], replaces }: Described = {}): Description {
  const lines = usage.replace(USAGE_PREFIX, '').split('\n')
  const first = lines[0]!
  const colon = first.indexOf(': ')
  const prose = lines[lines.indexOf('') + 1] ?? ''
  const fallback = lines.includes('') ? `${prose.charAt(0).toLowerCase()}${prose.slice(1)}`.replace(FULL_STOP, '') : ''

  return {
    synopsis: colon === -1 ? first : first.slice(0, colon),
    summary: colon === -1 ? fallback : first.slice(colon + 2),
    ...replaces === undefined ? {} : { replaces },
    examples: examples.map(example => typeof example === 'string' ? { line: example } : { line: example[0], note: example[1] }),
  }
}

// An `Examples:` section, after a blank line, with a line per example; nothing without one.
export function exampleRows(examples: Example[], colors = paint(process.stdout)): string[] {
  if (examples.length === 0)
    return []

  return ['', colors.bold('Examples:'), ...examples.map(example => typeof example === 'string' ? `  ${example}` : `  ${example[0]}  ${colors.dim(`# ${example[1]}`)}`)]
}

// A line per option, `-n, --times <value>  how many`, aligned on the visible text.
export function optionRows(options: Options, colors = paint(process.stdout)): string[] {
  const rows = Object.entries(options).map(([name, option]) => {
    const short = option.short === undefined ? '    ' : `${colors.cyan(`-${option.short}`)}, `
    const named = option.choices === undefined ? '<value>' : `<${option.choices.join('|')}>`
    const placeholder = option.optional === undefined ? named : `[${named}]`
    const value = option.type === 'string' ? ` ${colors.dim(placeholder)}` : ''

    return { flag: `${short}${colors.cyan(`--${name}`)}${value}`, width: `-x, --${name}`.length + (option.type === 'string' ? placeholder.length + 1 : 0), description: option.description ?? '' }
  })
  const width = Math.max(0, ...rows.map(row => row.width))

  return rows.map(row => row.description === '' ? `  ${row.flag}` : `  ${row.flag}${' '.repeat(width - row.width)}  ${colors.dim(row.description)}`)
}

// The positionals typed by their names: `<key>` or `KEY` a string, `[file]` an optional one, a name ending in `...` the rest.
type Slots<Names extends readonly string[]> = Names extends readonly [infer First extends string, ...infer Others extends readonly string[]]
  ? First extends `${string}...` | `${string}...]` ? string[] : First extends `[${string}` ? [string?, ...Slots<Others>] : [string, ...Slots<Others>]
  : Names extends readonly [] ? [] : string[]

// The parsed values with an option that has `choices` typed as their union, `undefined` kept when the option may be absent.
type Chosen<T extends Options, Values> = {
  [Name in keyof Values]: Name extends keyof T
    ? T[Name] extends { choices: infer Choices extends readonly string[] }
      ? Extract<Values[Name], undefined> | (NonNullable<Values[Name]> extends unknown[] ? Choices[number][] : Choices[number])
      : Values[Name]
    : Values[Name]
}

export interface ParseSettings<Names extends readonly string[] = string[]> {
  // Stops at the first `--` and hands what follows back untouched as `rest`, for a command that runs another (`out -n 200 -- <cmd>`).
  rest?: boolean
  // Takes `--no-<flag>` as `false` for a boolean flag, as parseArgs' own `allowNegative` does.
  allowNegative?: boolean
  // The positionals the command takes, by name as its usage writes them: `<key>` or `KEY` required, `[file]` optional, a last one ending in `...` taking any more. One missing or one too many is a usage error, and the positionals come back typed by these names.
  positionals?: Names
  // The values `__complete` offers for a positional, by its name as `positionals` writes it: `{ '<project>': async () => names }`. A positional without one completes as a path.
  candidates?: Partial<Record<Names[number], Candidates>>
  // Command lines shown under `Examples:` in the help, each with an optional dimmed note: `['ft ci HEAD~1', 'wait for the commit before the last']`.
  examples?: Example[]
  // What the command is reached for instead of, shown as `Instead of:` in the help and listed by `cli list`: 'sed -n N,Mp, grep -n chains and whole-file reads'.
  replaces?: string
}

export type Example = string | [line: string, note: string]

// The parts of the settings the help and the description show.
interface Described { examples?: Example[] | undefined, replaces?: string | undefined }

// The output flags every command takes, before its own help.
export const OUTPUT_OPTIONS = {
  color: { type: 'string', description: 'auto (on a terminal alone), always or never' },
  plain: { type: 'boolean', description: 'plain text, no colour or spinner: --color never' },
} as const satisfies Options

// Applies --color or --plain to the environment, where the kit's colours and redrawn lines read it and so do the processes a command starts; `auto` leaves it as it is.
export function applyOutput(color: string | undefined, plain: boolean | undefined, env: Record<string, string | undefined> = process.env): void {
  const when = plain === true ? 'never' : color ?? 'auto'

  if (when === 'auto')
    return

  if (when !== 'always' && when !== 'never')
    badUsage(`--color takes auto, always or never, not ${when}`)

  // FORCE_COLOR wins over NO_COLOR for the colours, so each choice drops the other.
  if (when === 'always') {
    env.FORCE_COLOR = '1'
    delete env.NO_COLOR
  }
  else {
    env.NO_COLOR = '1'
    delete env.FORCE_COLOR
  }
}

// Parses a command's arguments; on --help, prints its help and throws HelpShown, which ends the command with exit 0.
export function parse<const T extends Options, const Names extends readonly string[] = string[]>(args: string[], usage: string, options: T, settings: ParseSettings<Names> = {}) {
  // A command's own --color or --plain is its own to read.
  const output = Object.fromEntries(Object.entries(OUTPUT_OPTIONS).filter(([name]) => !(name in options))) as Omit<typeof OUTPUT_OPTIONS, keyof T>
  const all = { ...options, ...output, help: { type: 'boolean', short: 'h', description: 'show this help' } } as const

  const listing = listed(all, settings.allowNegative === true)

  if (completion.active)
    throw new Completing(listing, settings.positionals, settings.candidates)

  const separator = settings.rest === true ? args.indexOf('--') : -1
  const own = separator === -1 ? args : args.slice(0, separator)
  const rest = separator === -1 ? undefined : args.slice(separator + 1)

  let parsed

  try {
    parsed = parseArgs({ args: joinDashValues(withBare(own, all), all), options: all, allowPositionals: true, allowNegative: settings.allowNegative === true, strict: true })
  }
  catch (error) {
    const message = parseError(error)

    throw new UsageError(message, nearestOption(message, all, settings.allowNegative === true))
  }

  const values = parsed.values as { help?: boolean, color?: unknown, plain?: unknown }

  applyOutput('color' in output ? values.color as string | undefined : undefined, 'plain' in output ? values.plain as boolean | undefined : undefined)

  if (values.help === true) {
    console.log(wantsHelpJson() ? JSON.stringify(description(usage, settings)) : helpText(usage, listing, undefined, settings))

    throw new HelpShown()
  }

  checkChoices(parsed.values, all)
  checkConflicts(parsed.values, all)

  if (settings.positionals !== undefined)
    checkPositionals(parsed.positionals, settings.positionals)

  return { ...parsed, values: parsed.values as Chosen<T, typeof parsed.values>, positionals: parsed.positionals as Slots<Names>, rest }
}

// The options as the help and `__complete` list them: with `allowNegative`, `--no-<name>` for an option with a `negative` description, in place of the positive flag when that has none of its own.
function listed(options: Options, allowNegative: boolean): Options {
  if (!allowNegative)
    return options

  return Object.fromEntries(Object.entries(options).flatMap(([name, option]): [string, Options[string]][] => {
    if (option.type !== 'boolean' || option.negative === undefined)
      return [[name, option]]

    return [...option.description === undefined ? [] : [[name, option] as [string, Options[string]]], [`no-${name}`, { type: 'boolean', description: option.negative }]]
  }))
}

// The arguments with an optional-value option typed bare given its fallback, ahead of the next argument: `--out` becomes `--out 1` unless a value follows it.
function withBare(args: string[], options: Options): string[] {
  const bare = new Map<string, NonNullable<Options[string]['optional']>>(Object.entries(options).flatMap(([name, { short, optional }]) => optional === undefined ? [] : [[`--${name}`, optional] as const, ...short === undefined ? [] : [[`-${short}`, optional] as const]]))

  if (bare.size === 0)
    return args

  const separator = args.indexOf('--')
  const own = separator === -1 ? args : args.slice(0, separator)

  return [...own.flatMap((arg, index) => {
    const optional = bare.get(arg)
    const next = own[index + 1]
    const value = next !== undefined && (optional?.accepts === undefined ? !next.startsWith('-') : optional.accepts.test(next))

    return optional === undefined || value ? [arg] : [arg, optional.bare]
  }), ...separator === -1 ? [] : args.slice(separator)]
}

// A usage error for two options given together that one of them declares in conflict with the other.
function checkConflicts(values: Record<string, unknown>, options: Options): void {
  const given = (name: string) => values[name] !== undefined && values[name] !== false

  for (const [name, { conflicts = [] }] of Object.entries(options)) {
    const other = given(name) ? conflicts.find(given) : undefined

    if (other !== undefined)
      badUsage(`--${name} cannot be used with --${other}`)
  }
}

// A usage error for an option given a value outside its `choices`, in parseArgs' own order.
function checkChoices(values: Record<string, unknown>, options: Options): void {
  for (const [name, option] of Object.entries(options)) {
    if (option.choices === undefined)
      continue

    const given = values[name]

    for (const value of Array.isArray(given) ? given : [given]) {
      if (typeof value === 'string')
        oneOf(value, name, option.choices)
    }
  }
}

// The value when it is one of `choices`, else a usage error naming them: `--bump takes one of patch, minor, major, not big`. A name written `<bump>` is a positional and is printed as is, any other is an option printed `--name`.
export function oneOf<const Choices extends readonly string[]>(value: string, name: string, choices: Choices): Choices[number] {
  if (!choices.includes(value))
    badUsage(`${name.startsWith('<') ? name : `--${name}`} takes one of ${choices.join(', ')}, not ${value}`)

  return value
}

function checkPositionals(given: string[], names: readonly string[]): void {
  const variadic = names.at(-1)?.replace(']', '').endsWith('...') === true
  const required = names.filter(name => !name.startsWith('[')).length

  if (given.length < required)
    badUsage(`missing ${names[given.length]}`)

  if (!variadic && given.length > names.length)
    badUsage(`unexpected argument ${given[names.length]}`)
}

// The arguments with a string option's value joined to it as `--name=value` when that value starts with a dash and names no option, which parseArgs would refuse as ambiguous: `sub --from "- item"`.
function joinDashValues(args: readonly string[], options: Options): string[] {
  const longOf = new Map<string, string>(Object.entries(options).flatMap(([name, option]): [string, string][] => option.short === undefined ? [[`--${name}`, name]] : [[`--${name}`, name], [`-${option.short}`, name]]))
  const isOption = (arg: string) => arg === '--' || longOf.has(arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg)
  const joined: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (arg === '--')
      return [...joined, ...args.slice(i)]

    const name = longOf.get(arg)
    const next = args[i + 1]

    if (name !== undefined && options[name]?.type === 'string' && next !== undefined && next.startsWith('-') && next !== '-' && !isOption(next)) {
      joined.push(`--${name}=${next}`)
      i++
    }
    else {
      joined.push(arg)
    }
  }

  return joined
}

// parseArgs' message, its first sentence alone and lowercased as the kit's own: `unknown option '--nope'`.
function parseError(error: unknown): string {
  const message = upTo(error instanceof Error ? error.message : String(error), '. ')

  return `${message.charAt(0).toLowerCase()}${message.slice(1)}`
}

const UNKNOWN_OPTION = /^unknown option '(-[^']+)'/

// `did you mean --no-check?` for an unknown option within reach of a known one (shorts and `--no-<flag>` included), nothing when none is, so runCli keeps its `--help` hint.
function nearestOption(message: string, options: Options, allowNegative: boolean): string | undefined {
  const typed = UNKNOWN_OPTION.exec(message)?.[1]

  if (typed === undefined)
    return undefined

  const word = typed.replace(DASHES, '')

  if (word.length < 2 && !typed.startsWith('--'))
    return undefined

  const known = Object.entries(options).flatMap(([name, option]) => [
    ...option.short === undefined ? [] : [`-${option.short}`],
    `--${name}`,
    ...allowNegative && option.type === 'boolean' ? [`--no-${name}`] : [],
  ])
  const meant = closest(word, known.map(flag => flag.replace(DASHES, '')))

  return meant === undefined ? undefined : `did you mean ${known.find(flag => flag.replace(DASHES, '') === meant)}?`
}

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
