import type { Host, Result } from './checks'
import { firstLine } from './checks'

export interface Step {
  // The line as it is printed, and as it runs when `argv` is set.
  command: string
  argv?: string[] | undefined
}

const INSTALL = /^bun install -g (\S+)$/
// What a fix may run besides a global install of our own packages: nothing that installs a system package, nor prose such as "add ... to the PATH".
const RUNNABLE = /^(?:cli completions fish --install|claude plugin (?:install \S+ --marketplace \S+|disable \S+))$/

// The commands the failing checks print as their fix, the `bun install -g` ones joined into one call, each marked runnable or printed only.
export function planFixes(results: readonly Result[]): Step[] {
  const steps: Step[] = []
  const installs: string[] = []

  for (const { ok, fix } of results) {
    if (ok || fix === undefined)
      continue

    const install = INSTALL.exec(fix)

    if (install !== null)
      installs.push(install[1] ?? '')
    else
      steps.push({ command: fix, argv: RUNNABLE.test(fix) ? fix.split(' ') : undefined })
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

  for (const { command, argv } of steps) {
    if (argv === undefined) {
      outcomes.push({ command, status: 'not run', detail: 'not a command doctor runs: do it by hand' })

      continue
    }

    if (dry) {
      outcomes.push({ command, status: 'dry-run' })

      continue
    }

    const ran = await host.run(argv)

    outcomes.push(ran.code === 0 ? { command, status: 'ran' } : { command, status: 'failed', detail: `exit ${ran.code}: ${firstLine(ran.stderr || ran.stdout)}` })
  }

  return outcomes
}
