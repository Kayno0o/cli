import type { ExitRow, HeldSignals } from '@kaynooo/cli-kit'
import type { Placement } from './compose'
import type { Outcome } from './run'
import type { Project, Step } from './steps'
import { watch } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { duration, exitCodeOf, fail, formatDuration, header, holdSignals, ignoredFolders, paint, parse, printJson, table, wholeNumber } from '@kaynooo/cli-kit'
import { shellQuote } from '@kaynooo/cli-kit/shell'
import { place, placeSettings, programOf, shellIn, Stack } from './compose'
import { runFixers } from './fix'
import { changedPaths, narrow } from './narrow'
import { options, pick } from './options'
import { lastFailed, lastResults, logDirectory, outcomeJson, printOutcome, refusedStep, RESULTS_FILE, runStep } from './run'
import { discoverProjects, loadCheckConfig, STEP_NAMES } from './steps'

const usage = `check [path|workspace...] [--only <steps>] [--changed [--base <ref>]] [--failed] [--fail-fast] [--retry <n>] [--watch] [--quiet] [--timeout <duration>] [--slot | --no-slot] [--lock <name>] [--parallel] [--in <service> | --host] [--list]
check --fix [--only <fixers>] [--changed [--base <ref>]] [--timeout <duration>] [--in <service> | --host] [--list]

Runs the repo's check, typecheck, lint, fmt (fmt:check / format:check) and test steps from package.json (bun/pnpm/yarn/npm), composer.json, deno.json, Justfile, Makefile, Taskfile, mise, pyproject.toml, Go, Rust, Python, or PHP configs, or .checkrc.json; a folder with no steps runs its subfolders and workspaces.
A step runs inside the running compose service that mounts its folder and never starts one, and queues for a machine-wide slot when \`slot\` is installed.
A passing step prints one line, a failing one structured errors, and each step's full log is saved to the file its line ends with.
With --fix, the project's fix, lint:fix and fmt or format scripts run instead, then the formatters its files call for (php-cs-fixer, \`just --fmt\`, go fmt, cargo fmt, ruff), and the files they changed are listed.`

const EXITS: ExitRow[] = [[0, 'every step passed'], [1, 'one failed'], [2, 'bad usage, no step is found or a step timed out']]
const WATCH_DEBOUNCE_MS = 200

// A step with the folder it runs in, its subfolder's name and the compose service it runs inside, if any.
interface Planned extends Step {
  dir: string
  // `api/lint` for a subfolder's step, the step's name otherwise.
  label: string
  placement: Placement | undefined
  // Said after the command when --changed narrowed it, or could not.
  note?: string
}

// The command as `sh -c` takes it inside a slot, optionally holding a named lock.
function slotted(command: string, lock?: string): string {
  const lockFlag = lock === undefined ? '' : `--lock ${shellQuote(lock)} `

  return `slot ${lockFlag}-- sh -c ${shellQuote(command)}`
}

async function plan(steps: (Step & { project: Project })[], settings: ReturnType<typeof placeSettings>): Promise<Planned[]> {
  const planned: Planned[] = []

  for (const { project, ...step } of steps)
    planned.push({ ...step, dir: project.dir, label: project.name === undefined ? step.name : `${project.name}/${step.name}`, placement: await place(project.dir, programOf(step.command), settings) })

  return planned
}

// The steps narrowed to what the working tree changes against `base`, each said on its line.
async function narrowed(steps: Planned[], base?: string): Promise<Planned[]> {
  const cache = new Map<string, string[]>()
  const result: Planned[] = []

  for (const step of steps) {
    if (!cache.has(step.dir)) {
      const paths = await changedPaths(step.dir, base)

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

interface RunConfig {
  cwd: string
  steps: Planned[]
  slotting: boolean
  lock: string | undefined
  timeoutMs: number | undefined
  parallel: boolean
  failFast: boolean
  retries: number
  json: boolean
  quiet: boolean
}

async function runOnce(config: RunConfig, held: HeldSignals): Promise<number> {
  const { cwd, steps, slotting, lock, timeoutMs, parallel, failFast, retries, json, quiet } = config
  const directory = await logDirectory(cwd)
  const stack = new Stack()
  const width = Math.max(...steps.map(step => step.label.length))
  const outcomes: ReturnType<typeof outcomeJson>[] = []
  const heading = json || quiet ? '' : header('check', `${basename(cwd)} · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`, process.stdout)

  if (heading !== '')
    console.log(heading)

  const execute = async (step: Planned, signals: HeldSignals) => {
    const down = step.placement === undefined ? undefined : await stack.problem(step.placement)
    const command = slotting ? slotted(launch(step), lock) : launch(step)
    let logFile = join(directory, `${step.label.replaceAll('/', '-')}.log`)
    let outcome: Outcome
    let attempts = 0

    for (;;) {
      attempts += 1
      logFile = attempts === 1 ? join(directory, `${step.label.replaceAll('/', '-')}.log`) : join(directory, `${step.label.replaceAll('/', '-')}-try${attempts}.log`)
      outcome = down === undefined ? await runStep(command, step.dir, logFile, { ...(timeoutMs === undefined ? {} : { timeoutMs }), held: signals }) : await refusedStep(down, logFile)

      if (outcome.ok || down !== undefined || outcome.timedOut === true || signals.signal !== undefined || attempts > retries)
        break
    }

    return { step, logFile, outcome, attempts }
  }

  const report = ({ step, logFile, outcome, attempts }: Awaited<ReturnType<typeof execute>>) => {
    const retryNote = attempts > 1 ? `attempt ${attempts}/${retries + 1}` : undefined
    const notes = [step.note, retryNote, step.placement === undefined ? undefined : `in ${step.placement.service}`].filter((each): each is string => each !== undefined)
    const described = notes.length === 0 ? step.command : `${step.command} (${notes.join(', ')})`

    if (!json && !(quiet && outcome.ok))
      printOutcome(step.label, width, described, logFile, outcome, step.dir)

    outcomes.push(outcomeJson(step.label, step.command, logFile, outcome, step.placement?.service, step.dir))
  }

  if (parallel) {
    const children = new Set<Parameters<HeldSignals['forward']>[0]>()
    const shared: HeldSignals = { get signal() {
      return held.signal
    }, forward: child => children.add(child), release: held.release }

    held.forward({ kill: (signal) => {
      for (const child of children)
        child.kill(signal)
    } })

    let aborted = false
    const runs = steps.map(async (step) => {
      const result = await execute(step, shared)

      if (failFast && !result.outcome.ok && !aborted) {
        aborted = true

        for (const child of children)
          child.kill('SIGTERM')
      }

      return result
    })

    for (const run of runs)
      report(await run)
  }
  else {
    for (const step of steps) {
      const result = await execute(step, held)

      report(result)

      if (held.signal !== undefined || (failFast && !result.outcome.ok))
        break
    }
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

function shouldIgnoreWatchPath(filename: string | null): boolean {
  if (filename === null)
    return false

  const ignored = ignoredFolders(['.git', 'var', 'tmp'])

  return filename.split('/').some(part => part.startsWith('.git') || ignored.has(part))
}

async function watchAndRun(config: RunConfig, dirs: string[]): Promise<number> {
  const held = holdSignals()
  const watchers: ReturnType<typeof watch>[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let pending = false

  const trigger = async () => {
    if (running) {
      pending = true

      return
    }

    running = true

    try {
      await runOnce(config, held)
    }
    finally {
      running = false
    }

    if (pending && held.signal === undefined) {
      pending = false
      void trigger()
    }
  }

  try {
    await trigger()

    if (held.signal !== undefined)
      return exitCodeOf(null, held.signal)

    console.log(paint(process.stdout).dim('watching for changes (Ctrl-C to stop)...'))

    await new Promise<void>((resolveDone) => {
      const done = () => {
        if (timer !== undefined)
          clearTimeout(timer)

        resolveDone()
      }

      held.forward({ kill: () => done() })

      for (const dir of new Set(dirs)) {
        watchers.push(watch(dir, { recursive: true }, (_event, filename) => {
          if (held.signal !== undefined || shouldIgnoreWatchPath(filename))
            return

          if (timer !== undefined)
            clearTimeout(timer)

          timer = setTimeout(() => {
            if (held.signal === undefined)
              void trigger()
          }, WATCH_DEBOUNCE_MS)
        }))
      }
    })
  }
  finally {
    for (const watcher of watchers)
      watcher.close()

    held.release()
  }

  return held.signal === undefined ? 0 : exitCodeOf(null, held.signal)
}

// Runs the repo's steps in order and prints one line each, with what failed under a failing one; returns 0 only when every step passed.
export async function check(args: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parse(args, usage, options, {
    exits: EXITS,
    positionals: ['[path...]'],
    replaces: 'chaining docker compose exec <service> bun run check | tail, lint and test by hand, or bun run check && bun run lint && bun run test read through tail, and with --fix each fixer and formatter run by hand',
    examples: [
      'check',
      ['check packages/kit --only lint,test', 'one workspace, two steps'],
      ['check --changed --base main -x', 'narrowed to branch diff, fail fast'],
      ['check --in app', 'every step inside the app service'],
      ['check --fix --changed', 'fixers on changed files only'],
    ],
  })
  const settings = placeSettings(parsed.values)
  const rc = await loadCheckConfig(cwd)

  if (parsed.values.fix === true) {
    for (const flag of ['failed', 'slot', 'no-slot', 'parallel', 'fail-fast', 'watch'] as const) {
      if (parsed.values[flag] === true)
        fail(`--${flag} does not apply to --fix`)
    }

    if (parsed.values.retry !== undefined || parsed.values.lock !== undefined)
      fail('--retry and --lock do not apply to --fix')

    return runFixers(parsed.values, cwd)
  }

  const timeoutRaw = parsed.values.timeout ?? rc?.timeout
  const timeoutMs = timeoutRaw === undefined ? undefined : duration(timeoutRaw, 'timeout', 0)
  const retries = parsed.values.retry === undefined ? 0 : wholeNumber(parsed.values.retry, '--retry', 0, 0)
  const lock = parsed.values.lock ?? rc?.lock

  if (parsed.values.slot === true && parsed.values['no-slot'] === true)
    fail('--slot and --no-slot exclude each other')

  const hasSlot = Bun.which('slot', { PATH: process.env.PATH ?? '' }) !== null

  if ((parsed.values.slot === true || lock !== undefined) && !hasSlot)
    fail(`${lock === undefined ? '--slot' : '--lock'} needs the slot bin: bun install -g @kaynooo/cli-wait`)

  const slotting = parsed.values['no-slot'] !== true && hasSlot
  const targets = parsed.positionals
  const projects = await discoverProjects(cwd, targets)
  const found = projects.flatMap(project => project.steps.map(step => ({ ...step, project, label: project.name === undefined ? step.name : `${project.name}/${step.name}` })))

  if (found.length === 0)
    fail(`no ${STEP_NAMES.join(', ')} step in package.json, composer.json, deno.json, Justfile, Makefile, Taskfile, mise, pyproject.toml, Go, Rust, Python or PHP configs, nor in a subfolder`)

  const only = parsed.values.only ?? (rc?.only !== undefined && rc.only.length > 0 ? rc.only.join(',') : undefined)
  let wanted = pick(found, only)

  if (parsed.values.failed === true) {
    const failed = await lastFailed(cwd)

    if (failed === undefined || failed.length === 0)
      fail('no failed step in the last run of this folder')

    wanted = wanted.filter(step => failed.includes(step.label))

    if (wanted.length === 0)
      fail(`none of the steps picked failed in the last run, which failed ${failed.join(', ')}`)
  }

  const planned = await plan(wanted, settings)
  const base = parsed.values.base ?? rc?.base
  const steps = parsed.values.changed === true ? await narrowed(planned, base) : planned
  const json = parsed.values.json === true

  if (parsed.values.list === true) {
    if (json)
      printJson(steps.map(({ label, command, source, placement }) => ({ name: label, command, source, ...(placement === undefined ? {} : { in: placement.service }) })))
    else
      console.log(table(steps.map(step => [step.label, step.command, step.source, step.placement?.service ?? 'host'])))

    return 0
  }

  const config: RunConfig = {
    cwd,
    steps,
    slotting,
    lock,
    timeoutMs,
    parallel: parsed.values.parallel === true || rc?.parallel === true,
    failFast: parsed.values['fail-fast'] === true || rc?.failFast === true,
    retries,
    json,
    quiet: parsed.values.quiet === true,
  }

  if (parsed.values.watch === true)
    return watchAndRun(config, projects.map(project => project.dir))

  const held = holdSignals()

  try {
    return await runOnce(config, held)
  }
  finally {
    held.release()
  }
}
