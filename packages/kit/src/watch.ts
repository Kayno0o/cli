import process from 'node:process'
import { format } from 'node:util'
import { badUsage } from './args'
import { duration } from './input'
import { takesControlCodes } from './style'

const CLEAR_SCREEN = '\x1B[H\x1B[2J'
const DEFAULT_SECONDS = 2
const ATTACHED_SHORT = /^-w./
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
    else if (!arg.startsWith('--watch=') && !ATTACHED_SHORT.test(arg)) {
      rest.push(arg)
    }
  }

  return rest
}

/** Runs `step` again every interval until interrupted, clearing the screen once the output of each is whole, for a command that only prints. Needs a terminal: a pipe or an agent reads one answer, not a screen redrawn. */
export async function watching(value: string, step: () => Promise<number>, stream: NodeJS.WriteStream = process.stdout, sleep: (ms: number) => Promise<unknown> = Bun.sleep, rounds = Number.POSITIVE_INFINITY): Promise<number> {
  const interval = value === '' ? DEFAULT_SECONDS * 1000 : duration(value, 'watch', DEFAULT_SECONDS * 1000)

  if (!takesControlCodes(stream))
    badUsage('--watch redraws the screen, so it needs a terminal')

  let code = 0

  for (let round = 0; round < rounds; round++) {
    // The step's output is held until it is whole, so a slow one leaves the last screen up instead of a blank.
    const held: string[] = []
    const { log, info } = console
    const write = process.stdout.write.bind(process.stdout)
    const hold = (...parts: unknown[]) => void held.push(`${format(...parts)}\n`)

    console.log = hold
    console.info = hold
    process.stdout.write = (text: string | Uint8Array) => {
      held.push(typeof text === 'string' ? text : Buffer.from(text).toString())

      return true
    }

    try {
      code = await step()
    }
    finally {
      console.log = log
      console.info = info
      process.stdout.write = write
    }

    stream.write(`${CLEAR_SCREEN}${held.join('')}`)
    await sleep(interval)
  }

  return code
}
