import process from 'node:process'
import { badUsage } from './args'
import { duration } from './input'
import { takesControlCodes } from './style'

const CLEAR_SCREEN = '\x1B[H\x1B[2J'
const DEFAULT_SECONDS = 2
const INTERVAL = /^\d+(?:\.\d+)?(?:ms|[smh])?$/

/** The `--watch [interval]` flag every CLI words alike: bare it redraws every two seconds. */
export function watchOption(what: string) {
  return { type: 'string', short: 'w', optional: { bare: '', accepts: INTERVAL }, description: `redraw ${what} every 2s, or every interval given (500ms, 5s), until ctrl-c` } as const
}

/** The arguments without `--watch [interval]` (or `-w`), for the command the watch runs again each round. */
export function withoutWatch(args: string[]): string[] {
  const rest: string[] = []

  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!

    if (arg === '--watch' || arg === '-w') {
      if (args[at + 1] !== undefined && INTERVAL.test(args[at + 1]!))
        at++
    }
    else if (!arg.startsWith('--watch=')) {
      rest.push(arg)
    }
  }

  return rest
}

/** Runs `step` again every interval until interrupted, clearing the screen before each, for a command that only prints. Needs a terminal: a pipe or an agent reads one answer, not a screen redrawn. */
export async function watching(value: string, step: () => Promise<number>, stream: NodeJS.WriteStream = process.stdout, sleep: (ms: number) => Promise<unknown> = Bun.sleep, rounds = Number.POSITIVE_INFINITY): Promise<number> {
  const interval = value === '' ? DEFAULT_SECONDS * 1000 : duration(value, 'watch', DEFAULT_SECONDS * 1000)

  if (!takesControlCodes(stream))
    badUsage('--watch redraws the screen, so it needs a terminal')

  let code = 0

  for (let round = 0; round < rounds; round++) {
    stream.write(CLEAR_SCREEN)
    code = await step()
    await sleep(interval)
  }

  return code
}
