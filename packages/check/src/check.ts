import type { Step } from './steps'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, parse, printJson, table } from '@kaynooo/cli-kit'
import { logDirectory, outcomeJson, printOutcome, runStep } from './run'
import { discover, STEP_NAMES } from './steps'

const usage = `check [--only <steps>] [--list]

Runs the repo's check, typecheck, lint and test steps, from package.json scripts (through bun run), composer.json, a Justfile or a Makefile.
A passing step is one line, a failing one shows only what failed, and each step's full output is saved to the file whose path ends its line.
Exits 0 when every step passed, 1 when one failed, 2 on bad usage or when no step is found.
--json prints [{name, command, ok, ms, log, failed?}] once every step ran, --list --json [{name, command, source}].`

const options = {
  list: { type: 'boolean', short: 'l', description: 'print the steps found and the commands that run them, without running them' },
  only: { type: 'string', short: 'o', description: `comma separated steps to run, among ${STEP_NAMES.join(', ')}` },
  json: jsonOption(),
} as const

const COMMA = /\s*,\s*/

// The steps --only names, failing on one the repo lacks.
export function pick<T extends { name: string }>(steps: T[], only: string | undefined): T[] {
  if (only === undefined)
    return steps

  const names = only.split(COMMA).filter(name => name !== '')
  const unknown = names.filter(name => !steps.some(step => step.name === name))

  if (unknown.length > 0)
    fail(`no ${unknown.join(', ')} step here, found ${steps.map(step => step.name).join(', ')}`)

  return steps.filter(step => names.includes(step.name))
}

// Runs the repo's steps in order and prints one line each, with what failed under a failing one; returns 0 only when every step passed.
export async function check(args: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parse(args, usage, options, { replaces: 'bun run check && bun run lint && bun run test, read through tail', examples: ['check', ['check --only lint,test', 'two of the steps']] })

  const found = await discover(cwd)

  if (found.length === 0)
    fail(`no ${STEP_NAMES.join(', ')} step in package.json, composer.json, a Justfile or a Makefile`)

  const steps: Step[] = pick(found, parsed.values.only)

  const json = parsed.values.json === true

  if (parsed.values.list === true) {
    if (json)
      printJson(steps.map(({ name, command, source }) => ({ name, command, source })))
    else
      console.log(table(steps.map(step => [step.name, step.command, step.source])))

    return 0
  }

  const directory = logDirectory(cwd)

  await mkdir(directory, { recursive: true })

  const width = Math.max(...steps.map(step => step.name.length))
  const outcomes: ReturnType<typeof outcomeJson>[] = []

  for (const step of steps) {
    const logFile = join(directory, `${step.name}.log`)
    const outcome = await runStep(step.command, cwd, logFile)

    if (!json)
      printOutcome(step.name, width, step.command, logFile, outcome)

    outcomes.push(outcomeJson(step.name, step.command, logFile, outcome))
  }

  if (json)
    printJson(outcomes)

  return outcomes.every(outcome => outcome.ok) ? 0 : 1
}
