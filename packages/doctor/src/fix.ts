import type { Host, Result } from './checks'
import { firstLine } from './checks'

export interface Step {
  // The line as it is printed, and as it runs when `argv` is set.
  command: string
  argv?: string[] | undefined
  // Runs in place of `argv` for a fix that is several commands; an error message, undefined on success.
  apply?: ((host: Host) => Promise<string | undefined>) | undefined
}

// The runnable fixes from failing checks, with all `bun install -g` specs batched into one call, and non-runnable prose fixes printed as not run.
export function planFixes(results: readonly Result[]): Step[] {
  const steps: Step[] = []
  const installs: string[] = []

  for (const { ok, fix, fixAction, apply } of results) {
    if (ok || fix === undefined)
      continue

    if (apply !== undefined)
      steps.push({ command: fix, apply })
    else if (fixAction?.kind === 'install')
      installs.push(fixAction.spec)
    else if (fixAction?.kind === 'run')
      steps.push({ command: fix, argv: fixAction.argv })
    else
      steps.push({ command: fix })
  }

  if (installs.length === 0)
    return steps

  const command = `bun install -g ${installs.join(' ')}`

  return [{ command, argv: command.split(' ') }, ...steps]
}

export interface Outcome { command: string, status: 'ran' | 'failed' | 'dry-run' | 'not run', detail?: string }

// Runs each runnable step, or only reports it under `dry`; a step that is no command to run is reported as not run.
export async function applyFixes(host: Host, steps: readonly Step[], dry: boolean): Promise<Outcome[]> {
  const outcomes: Outcome[] = []

  for (const { command, argv, apply } of steps) {
    if (argv === undefined && apply === undefined) {
      outcomes.push({ command, status: 'not run', detail: 'not a command doctor runs: do it by hand' })

      continue
    }

    if (dry) {
      outcomes.push({ command, status: 'dry-run' })

      continue
    }

    if (apply !== undefined) {
      const error = await apply(host)

      outcomes.push(error === undefined ? { command, status: 'ran' } : { command, status: 'failed', detail: error })

      continue
    }

    const ran = await host.run(argv ?? [])

    outcomes.push(ran.code === 0 ? { command, status: 'ran' } : { command, status: 'failed', detail: `exit ${ran.code}: ${firstLine(ran.stderr || ran.stdout)}` })
  }

  return outcomes
}
