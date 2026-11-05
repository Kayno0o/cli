import type { Options } from '@kaynooo/cli-kit'
import { fail, wholeNumber } from '@kaynooo/cli-kit'

export const repoOption = {
  repo: { type: 'string', short: 'r', description: 'owner/name of the repository, instead of the one origin points at' },
} as const satisfies Options

export const openOption = {
  open: { type: 'boolean', short: 'o', description: 'also open the page in the browser (BROWSER, else the system opener)' },
} as const satisfies Options

const ISSUE_HASH = /^#/

export function issueNumber(value: string | undefined, usage: string): number {
  if (value === undefined)
    fail(`an issue number is needed\n\n${usage}`)

  return wholeNumber(value.replace(ISSUE_HASH, ''), '<issue>', 0)
}

export function issueNumbers(values: string[], usage: string): number[] {
  return values.length === 0 ? [issueNumber(undefined, usage)] : values.map(value => issueNumber(value, usage))
}
