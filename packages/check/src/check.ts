import type { Placement } from './compose'
import type { Project, Step } from './steps'
import { join } from 'node:path'
import process from 'node:process'
import { duration, exitCodeOf, fail, holdSignals, jsonOption, parse, printJson, table } from '@kaynooo/cli-kit'
import { shellQuote } from '@kaynooo/cli-kit/shell'
import { place, placeOptions, placeSettings, programOf, shellIn, Stack } from './compose'
import { logDirectory, outcomeJson, printOutcome, refusedStep, runStep } from './run'
import { discoverProjects, STEP_NAMES } from './steps'

const usage = `check [--only <steps>] [--timeout <duration>] [--slot] [--in <service> | --host] [--list]

Runs the repo's check, typecheck, lint and test steps, from package.json scripts (through bun run), composer.json, a Justfile or a Makefile, and for PHP from phpstan.neon (typecheck), .php-cs-fixer.dist.php (lint, dry-run) and phpunit.xml.dist (test) when composer.json has no such script.
A folder without steps but with subfolders that have some (api/ and client/) runs each one's, each line naming its subfolder.
A step runs inside the docker compose service that bind-mounts its folder (found in compose.yml, compose.yaml or docker-compose.yml, up to the repository root), at the matching path; a service that is down is never started, the step fails naming it. --in picks the service, --host forces the host.
A passing step is one line, a failing one shows only what failed, and each step's full output is saved to the file whose path ends its line.
A step still running after --timeout is ended with everything it started, but not what it started inside a container.
Exits 0 when every step passed, 1 when one failed, 2 on bad usage, when no step is found or when a step timed out.
--json prints [{name, command, in?, ok, ms, log, failed?}] once every step ran, --list --json [{name, command, source, in?}], in the compose service the step ran in.`

const options = {
  list: { type: 'boolean', short: 'l', description: 'print the steps found, the commands that run them and where (host or service), without running them' },
  only: { type: 'string', short: 'o', description: `comma separated steps to run, among ${STEP_NAMES.join(', ')}` },
  timeout: { type: 'string', short: 't', description: 'longest a step may run before it is ended (30s, 5m, 1h), none by default' },
  slot: { type: 'boolean', description: 'run each step through slot, queued behind the machine-wide slots of the other sessions (needs the slot bin)' },
  ...placeOptions,
  json: jsonOption(),
} as const

// A step with the folder it runs in, its subfolder's name and the compose service it runs inside, if any.
interface Planned extends Step {
  dir: string
  // `api/lint` for a subfolder's step, the step's name otherwise.
  label: string
  placement: Placement | undefined
}

// The command as `sh -c` takes it inside a slot.
function slotted(command: string): string {
  return `slot -- sh -c ${shellQuote(command)}`
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
    fail(`no ${unknown.join(', ')} step here, found ${[...new Set(steps.map(step => step.name))].join(', ')}`)

  return steps.filter(step => names.includes(step.name))
}

async function plan(steps: (Step & { project: Project })[], settings: ReturnType<typeof placeSettings>): Promise<Planned[]> {
  const planned: Planned[] = []

  for (const { project, ...step } of steps)
    planned.push({ ...step, dir: project.dir, label: project.name === undefined ? step.name : `${project.name}/${step.name}`, placement: await place(project.dir, programOf(step.command), settings) })

  return planned
}

// What the shell runs for a step: its command, inside the compose service when it has one.
function launch(step: Planned): string {
  return step.placement === undefined ? step.command : shellIn(step.placement, step.command)
}

// Runs the repo's steps in order and prints one line each, with what failed under a failing one; returns 0 only when every step passed.
export async function check(args: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parse(args, usage, options, { replaces: 'chaining docker compose exec <service> bun run check | tail, lint and test by hand, or bun run check && bun run lint && bun run test read through tail', examples: ['check', ['check --only lint,test', 'two of the steps'], ['check --in app', 'every step inside the app service']] })
  const settings = placeSettings(parsed.values)
  const projects = await discoverProjects(cwd)
  const found = projects.flatMap(project => project.steps.map(step => ({ ...step, project })))

  if (found.length === 0)
    fail(`no ${STEP_NAMES.join(', ')} step in package.json, composer.json, a Justfile, a Makefile or a PHP tool's config, nor in a subfolder`)

  const steps = await plan(pick(found, parsed.values.only), settings)
  const json = parsed.values.json === true

  if (parsed.values.list === true) {
    if (json)
      printJson(steps.map(({ label, command, source, placement }) => ({ name: label, command, source, ...(placement === undefined ? {} : { in: placement.service }) })))
    else
      console.log(table(steps.map(step => [step.label, step.command, step.source, step.placement?.service ?? 'host'])))

    return 0
  }

  if (parsed.values.slot === true && Bun.which('slot', { PATH: process.env.PATH ?? '' }) === null)
    fail('--slot needs the slot bin: bun install -g @kaynooo/wait-tools')

  const timeoutMs = parsed.values.timeout === undefined ? undefined : duration(parsed.values.timeout, 'timeout', 0)
  const directory = await logDirectory(cwd)
  const held = holdSignals()
  const stack = new Stack()
  const width = Math.max(...steps.map(step => step.label.length))
  const outcomes: ReturnType<typeof outcomeJson>[] = []

  try {
    for (const step of steps) {
      const logFile = join(directory, `${step.label.replaceAll('/', '-')}.log`)
      const down = step.placement === undefined ? undefined : await stack.problem(step.placement)
      const command = parsed.values.slot === true ? slotted(launch(step)) : launch(step)
      const outcome = down === undefined ? await runStep(command, step.dir, logFile, { ...(timeoutMs === undefined ? {} : { timeoutMs }), held }) : await refusedStep(down, logFile)

      if (!json)
        printOutcome(step.label, width, step.placement === undefined ? step.command : `${step.command} (in ${step.placement.service})`, logFile, outcome)

      outcomes.push(outcomeJson(step.label, step.command, logFile, outcome, step.placement?.service))

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
