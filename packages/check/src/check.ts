import type { Step } from './steps'
import { join } from 'node:path'
import process from 'node:process'
import { duration, exitCodeOf, fail, holdSignals, jsonOption, parse, printJson, table } from '@kaynooo/cli-kit'
import { logDirectory, outcomeJson, printOutcome, runStep } from './run'
import { discover, STEP_NAMES } from './steps'

const usage = `check [--only <steps>] [--timeout <duration>] [--slot] [--list]

Runs the repo's check, typecheck, lint and test steps, from package.json scripts (through bun run), composer.json, a Justfile or a Makefile.
A passing step is one line, a failing one shows only what failed, and each step's full output is saved to the file whose path ends its line.
A step still running after --timeout is ended with everything it started.
Exits 0 when every step passed, 1 when one failed, 2 on bad usage, when no step is found or when a step timed out.
--json prints [{name, command, ok, ms, log, failed?}] once every step ran, --list --json [{name, command, source}].`

const options = {
  list: { type: 'boolean', short: 'l', description: 'print the steps found and the commands that run them, without running them' },
  only: { type: 'string', short: 'o', description: `comma separated steps to run, among ${STEP_NAMES.join(', ')}` },
  timeout: { type: 'string', short: 't', description: 'longest a step may run before it is ended (30s, 5m, 1h), none by default' },
  slot: { type: 'boolean', description: 'run each step through slot, queued behind the machine-wide slots of the other sessions (needs the slot bin)' },
  json: jsonOption(),
} as const

// The command as `sh -c` takes it inside a slot.
function slotted(command: string): string {
  return `slot -- sh -c '${command.replaceAll('\'', '\'\\\'\'')}'`
}

const COMMA = /\s*,\s*/

// The steps --only names, failing on one the repo lacks.
export function pick<T extends { name: string }>(steps: T[], only: string | undefined): T[] {
  if (only === undefined)
    return steps

  const names = only.split(COMMA).filter(name => name !== '')

  if (names.length === 0)
    fail(`--only names no step, found ${steps.map(step => step.name).join(', ')}`)

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

  if (parsed.values.slot === true && Bun.which('slot', { PATH: process.env.PATH ?? '' }) === null)
    fail('--slot needs the slot bin: bun install -g @kaynooo/wait-tools')

  const timeoutMs = parsed.values.timeout === undefined ? undefined : duration(parsed.values.timeout, 'timeout', 0)
  const directory = await logDirectory(cwd)
  const held = holdSignals()
  const width = Math.max(...steps.map(step => step.name.length))
  const outcomes: ReturnType<typeof outcomeJson>[] = []

  try {
    for (const step of steps) {
      const logFile = join(directory, `${step.name}.log`)
      const outcome = await runStep(parsed.values.slot === true ? slotted(step.command) : step.command, cwd, logFile, { ...(timeoutMs === undefined ? {} : { timeoutMs }), held })

      if (!json)
        printOutcome(step.name, width, step.command, logFile, outcome)

      outcomes.push(outcomeJson(step.name, step.command, logFile, outcome))

      if (held.signal !== undefined)
        break
    }
  }
  finally {
    held.release()
  }

  if (json)
    printJson(outcomes)

  if (held.signal !== undefined)
    return exitCodeOf(null, held.signal)

  if (outcomes.some(outcome => outcome.timedOut === true))
    return 2

  return outcomes.every(outcome => outcome.ok) ? 0 : 1
}
