import { readFileSync } from 'node:fs'
import { fail } from '@kaynooo/cli-kit'

/** A failure the user is to fix (a manifest, a ref, an action refused): its message alone ends the command, where anything else shows its stack trace. */
export class KnownError extends Error {}

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

/** Ends the command on a known failure with its message and exit code 1; anything else is thrown on. */
export function failKnown(error: unknown): never {
  if (error instanceof KnownError)
    fail(error.message, 1)

  throw error
}
