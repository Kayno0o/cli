import { readFileSync } from 'node:fs'
import { fail } from '@kaynooo/cli-kit'
import { $ } from 'bun'

/** A failure the user is to fix (a manifest, a ref, an action refused): its message alone ends the command, where anything else shows its stack trace; `hint` says how to go on, under it. */
export class KnownError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message)
  }
}

const BOOT_TIME_LINE = /^btime (\d+)$/m

let bootedAt: number | undefined

/** When this machine booted, in ms: lock and ticket files outlive a reboot, and a pid written before it may name an unrelated process since. */
export function bootTime(): number {
  bootedAt ??= Number(readFileSync('/proc/stat', 'utf8').match(BOOT_TIME_LINE)?.[1] ?? 0) * 1000

  return bootedAt
}

/** Whether a process runs under that pid, one of another user's included. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The message of a failure the user is to fix, a command that failed included (docker stopped, a pull refused): what it said, not a stack trace; undefined for a bug. */
export function knownMessage(error: unknown): string | undefined {
  if (error instanceof KnownError)
    return error.message

  return error instanceof $.ShellError ? error.stderr.toString().trim() || error.message : undefined
}

export function knownHint(error: unknown): string | undefined {
  return error instanceof KnownError ? error.hint : undefined
}

/** What a failed command said, else the error's message, its hint after it. */
export function failureText(error: unknown): string {
  const hint = knownHint(error)

  return `${knownMessage(error) ?? (error instanceof Error ? error.message : String(error))}${hint === undefined ? '' : `\n${hint}`}`
}

/** Ends the command on a known failure with its message, its hint and exit code 1; anything else is thrown on. */
export function failKnown(error: unknown): never {
  const message = knownMessage(error)

  if (message !== undefined)
    fail(message, 1, knownHint(error))

  throw error
}
