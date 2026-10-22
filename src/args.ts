import type { ParseArgsOptionDescriptor } from 'node:util'
import { parseArgs } from 'node:util'

export type Options = Record<string, ParseArgsOptionDescriptor & { description: string }>

// Thrown to end a command with this exit code and message, which the cli prints as `ft <command>: <message>`.
export class Exit extends Error {
  constructor(message: string, readonly code: number) {
    super(message)
  }
}

export function fail(message: string, code = 2): never {
  throw new Exit(message, code)
}

export const repoOption = {
  repo: { type: 'string', short: 'r', description: 'owner/name of the repository, instead of the one origin points at' },
} as const satisfies Options

export function helpText(usage: string, options: Options): string {
  const rows = Object.entries(options).map(([name, option]) => [`${option.short === undefined ? '    ' : `-${option.short}, `}--${name}${option.type === 'string' ? ' <value>' : ''}`, option.description] as const)
  const width = Math.max(0, ...rows.map(([flag]) => flag.length))

  return [usage, '', ...rows.map(([flag, description]) => `  ${flag.padEnd(width)}  ${description}`)].join('\n')
}

// Parses a command's arguments, printing its help and returning undefined on --help.
export function parse<const T extends Options>(args: string[], usage: string, options: T) {
  const all = { ...options, help: { type: 'boolean', short: 'h', description: 'show this help' } } as const

  let parsed

  try {
    parsed = parseArgs({ args, options: all, allowPositionals: true, strict: true })
  }
  catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${helpText(usage, all)}`)
  }

  if ((parsed.values as { help?: boolean }).help === true) {
    console.log(helpText(usage, all))

    return undefined
  }

  return parsed
}

const ISSUE_HASH = /^#/

export function issueNumber(value: string | undefined, usage: string): number {
  if (value === undefined)
    fail(`an issue number is needed\n\n${usage}`)

  return wholeNumber(value.replace(ISSUE_HASH, ''), 'issue', 0)
}

export function issueNumbers(values: string[], usage: string): number[] {
  return values.length === 0 ? [issueNumber(undefined, usage)] : values.map(value => issueNumber(value, usage))
}

export function wholeNumber(value: string | undefined, name: string, fallback: number, min = 1): number {
  if (value === undefined)
    return fallback

  const number = Number(value)

  if (!Number.isInteger(number) || number < min)
    fail(`--${name} takes a whole number from ${min}, not ${value}`)

  return number
}
