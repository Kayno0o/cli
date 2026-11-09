import type { ExitRow } from '@kaynooo/cli-kit'
import type { Placement } from './compose'
import type { Project, Step } from './steps'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { duration, exitCodeOf, fail, formatDuration, header, holdSignals, paint, parse, printJson, table } from '@kaynooo/cli-kit'
import { shellQuote } from '@kaynooo/cli-kit/shell'
import { place, placeSettings, programOf, shellIn, Stack } from './compose'
import { runFixers } from './fix'
import { changedPaths, narrow } from './narrow'
import { options, pick } from './options'
import { lastFailed, lastResults, logDirectory, outcomeJson, printOutcome, refusedStep, RESULTS_FILE, runStep } from './run'
import { discoverProjects, STEP_NAMES } from './steps'

const usage = `check [--only <steps>] [--changed] [--failed] [--quiet] [--timeout <duration>] [--slot] [--in <service> | --host] [--list]
check --fix [--only <fixers>] [--timeout <duration>] [--in <service> | --host] [--list]

Runs the repo's check, typecheck, lint and test steps, from package.json scripts (through bun run), composer.json, a Justfile or a Makefile, and for PHP from phpstan.neon (typecheck), .php-cs-fixer.dist.php (lint, dry-run) and phpunit.xml.dist (test) when composer.json has no such script.
A folder without steps but with subfolders that have some (api/ and client/) runs each one's, each line naming its subfolder.
A step runs inside the docker compose service that bind-mounts its folder (found in compose.yml, compose.yaml or docker-compose.yml, up to the repository root), at the matching path; a service that is down is never started, the step fails naming it. --in picks the service, --host forces the host.
A passing step is one line, a failing one shows only what failed, and each step's full output is saved to the file whose path ends its line.
With --changed, lint and test run on the files changed against HEAD (staged, unstaged and untracked) when their script is a bare linter (keslint, eslint, oxlint) or a bare \`bun test\`: lint on the changed source files, test on the changed test files and the tests next to the changed sources. Every other step, and a test step finding no test for the diff, runs in full and the line says so.
With --quiet, passing steps print nothing, and a fully passing run prints nothing at all: only the failing steps and the closing summary of a run that failed.
A step still running after --timeout is ended with everything it started, but not what it started inside a container.
With --failed, only the steps that failed in the last run of this folder run again, read from that run's folder of logs; when no last run failed, it says so and exits 2.
With --fix, the folder's fixers and formatters run instead of the steps, exactly as the \`fix\` bin does (it is the alias of \`check --fix\`): its own scripts, php-cs-fixer, just --fmt, go fmt, cargo fmt, ruff and the Makefile's .PHONY targets, then the files the run changed are listed. --only then names fixers, as --list prints them; --changed, --failed and --slot do not apply.
--json prints [{name, command, in?, ok, ms, log, failed?}] once every step ran, --list --json [{name, command, source, in?}], in the compose service the step ran in; with --fix the shape \`fix --json\` prints.`

const EXITS: ExitRow[] = [[0, 'every step passed'], [1, 'one failed'], [2, 'bad usage, no step is found or a step timed out']]

// A step with the folder it runs in, its subfolder's name and the compose service it runs inside, if any.
interface Planned extends Step {
  dir: string
  // `api/lint` for a subfolder's step, the step's name otherwise.
  label: string
  placement: Placement | undefined
  // Said after the command when --changed narrowed it, or could not.
  note?: string
}

// The command as `sh -c` takes it inside a slot.
function slotted(command: string): string {
  return `slot -- sh -c ${shellQuote(command)}`
}

async function plan(steps: (Step & { project: Project })[], settings: ReturnType<typeof placeSettings>): Promise<Planned[]> {
  const planned: Planned[] = []

  for (const { project, ...step } of steps)
    planned.push({ ...step, dir: project.dir, label: project.name === undefined ? step.name : `${project.name}/${step.name}`, placement: await place(project.dir, programOf(step.command), settings) })

  return planned
}

// The steps narrowed to what the working tree changes against HEAD, each said on its line.
async function narrowed(steps: Planned[]): Promise<Planned[]> {
  const cache = new Map<string, string[]>()
  const result: Planned[] = []

  for (const step of steps) {
    if (!cache.has(step.dir)) {
      const paths = await changedPaths(step.dir)

      if (paths === undefined)
        fail('--changed needs a git repository')

      cache.set(step.dir, paths)
    }

    const { command, note } = await narrow(step, step.dir, cache.get(step.dir) ?? [])

    result.push({ ...step, command, note })
  }

  return result
}

// What the shell runs for a step: its command, inside the compose service when it has one.
function launch(step: Planned): string {
  return step.placement === undefined ? step.command : shellIn(step.placement, step.command)
}

// The line closing a run on a terminal: what passed, what failed and the time the steps took together.
export function summaryLine(outcomes: ReturnType<typeof outcomeJson>[]): string {
  const colors = paint(process.stdout)
  const failed = outcomes.filter(outcome => !outcome.ok).length
  const passed = outcomes.length - failed
  const parts = [colors.green(`${passed} passed`), ...failed === 0 ? [] : [colors.red(`${failed} failed`)], colors.dim(formatDuration(outcomes.reduce((sum, outcome) => sum + outcome.ms, 0)))]

  return parts.join(colors.dim(' · '))
}

// Runs the repo's steps in order and prints one line each, with what failed under a failing one; returns 0 only when every step passed.
export async function check(args: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parse(args, usage, options, { exits: EXITS, replaces: 'chaining docker compose exec <service> bun run check | tail, lint and test by hand, or bun run check && bun run lint && bun run test read through tail', examples: ['check', ['check --only lint,test', 'two of the steps'], ['check --in app', 'every step inside the app service']] })
  const settings = placeSettings(parsed.values)

  if (parsed.values.fix === true) {
    for (const flag of ['changed', 'failed', 'slot'] as const) {
      if (parsed.values[flag] === true)
        fail(`--${flag} does not apply to --fix`)
    }

    return runFixers(parsed.values, cwd)
  }

  const timeoutMs = parsed.values.timeout === undefined ? undefined : duration(parsed.values.timeout, 'timeout', 0)

  if (parsed.values.slot === true && Bun.which('slot', { PATH: process.env.PATH ?? '' }) === null)
    fail('--slot needs the slot bin: bun install -g @kaynooo/cli-wait')

  const projects = await discoverProjects(cwd)
  const found = projects.flatMap(project => project.steps.map(step => ({ ...step, project })))

  if (found.length === 0)
    fail(`no ${STEP_NAMES.join(', ')} step in package.json, composer.json, a Justfile, a Makefile or a PHP tool's config, nor in a subfolder`)

  let wanted = pick(found, parsed.values.only)

  if (parsed.values.failed === true) {
    const failed = await lastFailed(cwd)

    if (failed === undefined || failed.length === 0)
      fail('no failed step in the last run of this folder')

    wanted = wanted.filter(step => failed.includes(step.project.name === undefined ? step.name : `${step.project.name}/${step.name}`))

    if (wanted.length === 0)
      fail(`none of the steps picked failed in the last run, which failed ${failed.join(', ')}`)
  }

  const planned = await plan(wanted, settings)
  const steps = parsed.values.changed === true ? await narrowed(planned) : planned
  const json = parsed.values.json === true

  if (parsed.values.list === true) {
    if (json)
      printJson(steps.map(({ label, command, source, placement }) => ({ name: label, command, source, ...(placement === undefined ? {} : { in: placement.service }) })))
    else
      console.log(table(steps.map(step => [step.label, step.command, step.source, step.placement?.service ?? 'host'])))

    return 0
  }

  const directory = await logDirectory(cwd)
  const held = holdSignals()
  const stack = new Stack()
  const width = Math.max(...steps.map(step => step.label.length))
  const outcomes: ReturnType<typeof outcomeJson>[] = []
  const quiet = parsed.values.quiet === true
  const heading = json || quiet ? '' : header('check', `${basename(cwd)} · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`, process.stdout)

  if (heading !== '')
    console.log(heading)

  try {
    for (const step of steps) {
      const logFile = join(directory, `${step.label.replaceAll('/', '-')}.log`)
      const down = step.placement === undefined ? undefined : await stack.problem(step.placement)
      const command = parsed.values.slot === true ? slotted(launch(step)) : launch(step)
      const outcome = down === undefined ? await runStep(command, step.dir, logFile, { ...(timeoutMs === undefined ? {} : { timeoutMs }), held }) : await refusedStep(down, logFile)

      if (!json && !(quiet && outcome.ok))
        printOutcome(step.label, width, `${step.command}${step.note === undefined ? '' : ` (${step.note})`}${step.placement === undefined ? '' : ` (in ${step.placement.service})`}`, logFile, outcome)

      outcomes.push(outcomeJson(step.label, step.command, logFile, outcome, step.placement?.service))

      if (held.signal !== undefined)
        break
    }
  }
  finally {
    held.release()
  }

  // A partial run replaces the entries of the steps it ran and keeps the others', so --failed still knows what failed before.
  const ran = outcomes.map(({ name, ok }) => ({ name, ok }))
  const kept = (await lastResults(cwd) ?? []).filter(({ name }) => !ran.some(each => each.name === name))

  await writeFile(join(directory, RESULTS_FILE), JSON.stringify([...kept, ...ran]), { mode: 0o600 })

  if (json)
    printJson(outcomes)
  else if (heading !== '' || (quiet && !outcomes.every(outcome => outcome.ok)))
    console.log(summaryLine(outcomes))

  if (held.signal !== undefined)
    return exitCodeOf(null, held.signal)

  if (outcomes.some(outcome => outcome.timedOut === true))
    return 2

  return outcomes.every(outcome => outcome.ok) ? 0 : 1
}
