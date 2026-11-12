import type { Described, Example, Options } from './args'
import process from 'node:process'
import { outputMode } from './mode'
import { paint } from './style'

// Optional parts of a usage line, `[options]` or `[tag]`, dimmed in the help.
// eslint-disable-next-line no-control-regex -- an escape code's bracket is what it skips
const OPTIONAL = /(?<!\x1B)\[[^\]]+\]/g
const USAGE_PREFIX = /^usage:\s*/i
const FULL_STOP = /\.$/
// A `code` span, or a flag standing alone in prose: `--only`, `-k`, not the dash of dry-run.
const PROSE_MARKS = /`([^`\n]+)`|(?<![\w-])(--[a-z][\w-]*|-[a-z](?![\w-]))/gi

// `Usage: <synopsis>` with its optional parts dimmed, then the summary in bold on its own line and the details, their flags and code spans marked; the usage may start with its own `usage:`.
export function usageLine(usage: string, colors = paint(process.stdout)): string {
  const lines = usage.replace(USAGE_PREFIX, '').split('\n')
  const blank = lines.indexOf('')
  const synopses = blank === -1 ? lines : lines.slice(0, blank)
  const details = blank === -1 ? [] : lines.slice(blank + 1)
  const colon = synopses[0]!.indexOf(': ')
  const inline = synopses[0]!.slice(colon + 2)
  // A summary after the synopsis's colon starts in lower case, as the rest of that line ran on.
  const summary = colon === -1 ? details.shift() : `${inline.charAt(0).toUpperCase()}${inline.slice(1)}`

  if (colon !== -1)
    synopses[0] = synopses[0]!.slice(0, colon)

  const head = `${colors.bold('Usage:')} ${synopses.map(line => line.replaceAll(OPTIONAL, part => colors.dim(part))).join('\n')}`
  const lead = summary === undefined ? [] : ['', colors.bold(prose(summary, colors))]
  const rest = details.length === 0 ? [] : ['', ...details.map(line => prose(line, colors))]

  return [head, ...lead, ...rest].join('\n')
}

// A line of the description with its flags cyan and its code spans bold, the backticks dropped once the span is marked.
function prose(line: string, colors: ReturnType<typeof paint>): string {
  if (colors.cyan('x') === 'x')
    return line

  return line.replaceAll(PROSE_MARKS, (match, code: string | undefined, flag: string | undefined) => code === undefined ? colors.cyan(flag ?? match) : colors.bold(code))
}

export function helpText(usage: string, options: Options, colors = paint(process.stdout), { examples = [], exits = [] }: Described = {}): string {
  return [usageLine(usage, colors), '', colors.bold('Options:'), ...optionRows(options, colors), ...exitRows(exits, colors), ...exampleRows(examples, colors)].join('\n')
}

// An exit code and what it means.
export type ExitRow = [code: number | string, meaning: string]

// An `Exit codes:` line after the options, `0 clean, 1 a finding`; nothing without one.
export function exitRows(exits: ExitRow[], colors = paint(process.stdout)): string[] {
  if (exits.length === 0)
    return []

  return ['', `${colors.bold('Exit codes:')} ${exits.map(([code, meaning]) => `${colors.cyan(String(code))} ${meaning}`).join(', ')}`]
}

// What a bin's --help prints under KIT_HELP=json, for `cli list` to read without parsing the text.
export interface Description {
  synopsis: string
  summary: string
  replaces?: string
  examples: { line: string, note?: string }[]
  exits?: { code: number | string, meaning: string }[]
  // The flags of a command with no subcommands, for a test comparing them with what a README documents.
  options?: { name: string, short?: string, description?: string }[]
}

export function wantsHelpJson(env: Record<string, string | undefined> = process.env): boolean {
  return env.KIT_HELP === 'json'
}

// The synopsis and the summary a usage's first line splits into at its first `: `, else the first line after the synopses as the summary, with the examples spelled out.
export function description(usage: string, { examples = [], replaces, exits }: Described = {}, options?: Options): Description {
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
    ...exits === undefined ? {} : { exits: exits.map(([code, meaning]) => ({ code, meaning })) },
    ...options === undefined ? {} : { options: Object.entries(options).map(([name, { short, description }]) => ({ name, ...short === undefined ? {} : { short }, ...description === undefined ? {} : { description } })) },
  }
}

// An `Examples:` section, after a blank line, with a line per example; nothing without one, and nothing for an agent, which reads the usage and the options.
export function exampleRows(examples: Example[], colors = paint(process.stdout)): string[] {
  if (examples.length === 0 || outputMode() === 'agent')
    return []

  return ['', colors.bold('Examples:'), ...examples.map(example => typeof example === 'string' ? `  ${example}` : `  ${example[0]}  ${colors.dim(`# ${example[1]}`)}`)]
}

// Choices longer than this are listed after the description, so one option does not push every description off the screen.
const MAX_INLINE_CHOICES = 24

// A line per option, `-n, --times <value>  how many`, aligned on the visible text.
export function optionRows(options: Options, colors = paint(process.stdout)): string[] {
  const rows = Object.entries(options).map(([name, option]) => {
    const short = option.short === undefined ? '    ' : `${colors.cyan(`-${option.short}`)}, `
    const choices = option.choices?.join('|')
    const inline = choices !== undefined && choices.length <= MAX_INLINE_CHOICES
    const named = inline ? `<${choices}>` : '<value>'
    const placeholder = option.optional === undefined ? named : `[${named}]`
    const value = option.type === 'string' ? ` ${colors.dim(placeholder)}` : ''
    const described = choices === undefined || inline ? option.description ?? '' : [option.description, `one of ${option.choices!.join(', ')}`].filter(Boolean).join('; ')

    return { flag: `${short}${colors.cyan(`--${name}`)}${value}`, width: `-x, --${name}`.length + (option.type === 'string' ? placeholder.length + 1 : 0), description: described }
  })
  const width = Math.max(0, ...rows.map(row => row.width))

  return rows.map(row => row.description === '' ? `  ${row.flag}` : `  ${row.flag}${' '.repeat(width - row.width)}  ${colors.dim(row.description)}`)
}
