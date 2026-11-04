import type { Described, Example, Options } from './args'
import process from 'node:process'
import { paint } from './style'

// Optional parts of a usage line, `[options]` or `[tag]`, dimmed in the help.
const OPTIONAL = /\[[^\]]+\]/g
const USAGE_PREFIX = /^usage:\s*/i
const FULL_STOP = /\.$/

// `Usage: <usage>`, the usage given with or without its own `usage:`, optional parts dimmed.
export function usageLine(usage: string, colors = paint(process.stdout)): string {
  return `${colors.bold('Usage:')} ${usage.replace(USAGE_PREFIX, '').replaceAll(OPTIONAL, part => colors.dim(part))}`
}

export function helpText(usage: string, options: Options, colors = paint(process.stdout), { examples = [], replaces, exits = [] }: Described = {}): string {
  return [usageLine(usage, colors), ...replacesRows(replaces, colors), '', colors.bold('Options:'), ...optionRows(options, colors), ...exitRows(exits, colors), ...exampleRows(examples, colors)].join('\n')
}

// An exit code and what it means.
export type ExitRow = [code: number | string, meaning: string]

// An `Exits:` block, after a blank line, a line per code with the codes aligned; nothing without one.
export function exitRows(exits: ExitRow[], colors = paint(process.stdout)): string[] {
  if (exits.length === 0)
    return []

  const width = Math.max(...exits.map(([code]) => String(code).length))

  return ['', colors.bold('Exits:'), ...exits.map(([code, meaning]) => `  ${colors.cyan(String(code).padEnd(width))}  ${meaning}`)]
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
