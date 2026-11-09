import { fail, jsonOption } from '@kaynooo/cli-kit'
import { placeOptions } from './compose'
import { STEP_NAMES } from './steps'

// What `fix` and `check --fix` share.
export const fixOptions = {
  list: { type: 'boolean', short: 'l', description: 'print the steps (or, with --fix, the fixers) found, the commands that run them and where (host or service), without running them' },
  only: { type: 'string', short: 'o', description: `comma separated steps to run, among ${STEP_NAMES.join(', ')}; with --fix the fixers to run, by the names --list prints` },
  timeout: { type: 'string', short: 't', description: 'longest a step or fixer may run before it is ended (30s, 5m, 1h), none by default' },
  ...placeOptions,
  json: jsonOption(),
} as const

// The one options table of `check`; `fix` is `check --fix` and takes the shared part.
export const options = {
  ...fixOptions,
  fix: { type: 'boolean', short: 'f', description: 'run the folder\'s fixers and formatters instead of the steps, as the fix bin does' },
  quiet: { type: 'boolean', short: 'q', description: 'print nothing for a passing step, and nothing at all when every step passes' },
  failed: { type: 'boolean', description: 'run only the steps that failed in the last run of this folder, read from the run folder' },
  changed: { type: 'boolean', short: 'c', description: 'narrow lint and test to the files changed against HEAD (a bare linter script, a bare bun test script), every other step runs in full and says so' },
  slot: { type: 'boolean', description: 'run each step through slot, queued behind the machine-wide slots of the other sessions (needs the slot bin)' },
  parallel: { type: 'boolean', description: 'run the steps at the same time, printing each one\'s output in step order' },
} as const

const COMMA = /\s*,\s*/

// The steps --only names, failing on one the repo lacks.
export function pick<T extends { name: string }>(steps: T[], only: string | undefined, noun = 'step'): T[] {
  if (only === undefined)
    return steps

  const names = only.split(COMMA).filter(name => name !== '')

  if (names.length === 0)
    fail(`--only names no ${noun}, found ${steps.map(step => step.name).join(', ')}`)

  const unknown = names.filter(name => !steps.some(step => step.name === name))

  if (unknown.length > 0)
    fail(`no ${unknown.join(', ')} ${noun} here, found ${[...new Set(steps.map(step => step.name))].join(', ')}`)

  return steps.filter(step => names.includes(step.name))
}
