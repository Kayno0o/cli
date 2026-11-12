import { fail, isListening, jsonOption, parse, printJson, warn, wholeNumber } from '@kaynooo/cli-kit'
import { DEFAULT_MAX_PORT, MAX_PORT, MIN_PORT, stringToPort } from '../port'

const usage = `stack port <name>

Prints the port a name always hashes to (32-bit FNV-1a, ${MIN_PORT}-${DEFAULT_MAX_PORT} by default, below Linux's ephemeral range), so a service keeps the same port on every machine.
Says on stderr when something already listens on it; the exit code stays 0.\n\nExits 0 when it printed the port, 2 on a usage error.`

const options = {
  min: { type: 'string', description: `lowest port (${MIN_PORT}, nothing lower is allowed)` },
  max: { type: 'string', description: `highest port (${DEFAULT_MAX_PORT}, or ${MAX_PORT} when --min reaches it, up to ${MAX_PORT})` },
  json: jsonOption('{name, port, listening}'),
} as const

// eslint-disable-next-line ts/require-await -- commands are async by contract
export async function port(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options)

  const [name] = parsed.positionals

  if (name === undefined)
    fail('a name is needed')

  const min = wholeNumber(parsed.values.min, 'min', MIN_PORT, MIN_PORT)

  if (min > MAX_PORT)
    fail(`--min goes up to ${MAX_PORT}, not ${min}`)

  // Past the default range, --min alone reaches up to the highest port, so the names still spread.
  const max = wholeNumber(parsed.values.max, 'max', min < DEFAULT_MAX_PORT ? DEFAULT_MAX_PORT : MAX_PORT, min)

  if (max > MAX_PORT)
    fail(`--max goes up to ${MAX_PORT}, not ${max}`)

  const number = stringToPort(name, min, max)

  if (parsed.values.json === true) {
    printJson({ name, port: number, listening: isListening(number) })

    return 0
  }

  console.log(number)

  if (isListening(number))
    warn(`port ${number} is already in use on this machine`)

  return 0
}
