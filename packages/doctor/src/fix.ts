import type { Host, Result } from './checks'
import { firstLine } from './checks'

const MAX_PASSES = 3

export interface Step {
  // The line as it is printed, and as it runs when `argv` is set.
  command: string
  argv?: string[] | undefined
  // Runs in place of `argv` for a fix that is several commands; an error message, undefined on success.
  apply?: ((host: Host) => Promise<string | undefined>) | undefined
}

// The runnable fixes from failing checks, ordered so package installs run first, dead bin links are cleaned before completions refresh, and non-runnable prose fixes are printed as not run.
export function planFixes(results: readonly Result[]): Step[] {
  const deadBinSteps: Step[] = []
  const otherSteps: Step[] = []
  const installs: string[] = []

  for (const { check, ok, fix, fixAction, apply } of results) {
    if (ok || fix === undefined)
      continue

    if (fixAction?.kind === 'install') {
      installs.push(fixAction.spec)

      continue
    }

    let step: Step

    if (apply !== undefined)
      step = { command: fix, apply }
    else if (fixAction?.kind === 'run')
      step = { command: fix, argv: fixAction.argv }
    else
      step = { command: fix }

    if (check === 'dead-bins')
      deadBinSteps.push(step)
    else
      otherSteps.push(step)
  }

  const steps = [...deadBinSteps, ...otherSteps]

  if (installs.length === 0)
    return steps

  const command = `bun install -g ${installs.join(' ')}`

  return [{ command, argv: command.split(' ') }, ...steps]
}

export interface Outcome { command: string, status: 'ran' | 'failed' | 'dry-run' | 'not run', detail?: string }

// Runs each runnable step, or only reports it under `dry`; a step that is no command to run is reported as not run.
export async function applyFixes(host: Host, steps: readonly Step[], dry: boolean, onOutcome?: (outcome: Outcome) => void): Promise<Outcome[]> {
  const outcomes: Outcome[] = []
  const record = (outcome: Outcome) => {
    outcomes.push(outcome)
    onOutcome?.(outcome)
  }

  for (const { command, argv, apply } of steps) {
    if (argv === undefined && apply === undefined) {
      record({ command, status: 'not run', detail: 'not a command doctor runs: do it by hand' })

      continue
    }

    if (dry) {
      record({ command, status: 'dry-run' })

      continue
    }

    if (apply !== undefined) {
      const error = await apply(host)

      record(error === undefined ? { command, status: 'ran' } : { command, status: 'failed', detail: error })

      continue
    }

    const ran = await host.run(argv ?? [])

    record(ran.code === 0 ? { command, status: 'ran' } : { command, status: 'failed', detail: `exit ${ran.code}: ${firstLine(ran.stderr || ran.stdout)}` })
  }

  return outcomes
}

export interface FixRun {
  results: Result[]
  outcomes: Outcome[]
  // Every check that failed on any pass, so callers can report just what changed or remains broken.
  touched: Set<string>
  // True when at least one fix actually ran (false on dry-run or when every step failed / was not runnable).
  changed: boolean
}

// Distinct per failure detail so a multi-pass loop skips a step that already ran for the same failure, but retries if a new failure appeared.
function stepKey(step: Step, results: readonly Result[]): string {
  const details = results.filter(result => !result.ok && result.fix === step.command).map(result => result.detail)

  return details.length === 0 ? step.command : `${step.command}\0${details.join('\0')}`
}

// Runs fixes in passes until everything passes or no new fix remains, so follow-up cleanups (dead-bins, completions) after a package upgrade converge in one command.
export async function convergeFixes(
  host: Host,
  initial: Result[],
  recheck: () => Promise<Result[]>,
  { dry = false, onOutcome }: { dry?: boolean, onOutcome?: (outcome: Outcome) => void } = {},
): Promise<FixRun> {
  let results = initial
  const outcomes: Outcome[] = []
  const touched = new Set<string>(results.filter(result => !result.ok).map(result => result.check))
  const attempted = new Set<string>()
  let changed = false

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const steps = planFixes(results).filter(step => !attempted.has(stepKey(step, results)))

    if (steps.length === 0)
      break

    for (const step of steps)
      attempted.add(stepKey(step, results))

    const passOutcomes = await applyFixes(host, steps, dry, onOutcome)

    outcomes.push(...passOutcomes)

    if (dry || !passOutcomes.some(outcome => outcome.status === 'ran'))
      break

    changed = true
    results = await recheck()

    for (const result of results) {
      if (!result.ok)
        touched.add(result.check)
    }

    if (results.every(result => result.ok))
      break
  }

  return { results, outcomes, touched, changed }
}
