import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { DEFAULT_MAX_PORT, fail, isListening, jsonOption, MAX_PORT, MIN_PORT, paint, parse, printJson, stringToPort, table, warn, wholeNumber } from '@kaynooo/cli-kit'
import { allServices, key, stateColor } from './stack'

const portUsage = `dc port <name> [--min <n>] [--max <n>] [--json]

Prints the deterministic host port a service name hashes to (32-bit FNV-1a, ${MIN_PORT}-${DEFAULT_MAX_PORT} by default, below Linux's ephemeral range), so a service keeps the same port on every machine.
Warns on stderr when something already listens on it; exit code stays 0.`

const PORT_EXITS: ExitRow[] = [[0, 'printed the port'], [2, 'a usage error']]

const portsUsage = `dc ports [--json]

Lists published host -> container ports across all discovered compose services in this folder and its children.`

const PORTS_EXITS: ExitRow[] = [[0, 'listed published ports'], [1, 'no compose service found'], [2, 'a usage error']]

export function dcPort(args: string[]): number {
  const parsed = parse(args, portUsage, {
    min: { type: 'string', description: `lowest port (${MIN_PORT}, nothing lower is allowed)` },
    max: { type: 'string', description: `highest port (${DEFAULT_MAX_PORT}, or ${MAX_PORT} when --min reaches it, up to ${MAX_PORT})` },
    json: jsonOption('{name, port, listening}'),
  }, { positionals: ['<name>'], exits: PORT_EXITS })

  const [name] = parsed.positionals

  if (name === undefined)
    fail('a name is needed: dc port <name>')

  const min = wholeNumber(parsed.values.min, 'min', MIN_PORT, MIN_PORT)

  if (min > MAX_PORT)
    fail(`--min goes up to ${MAX_PORT}, not ${min}`)

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

export async function dcPorts(args: string[]): Promise<number> {
  const parsed = parse(args, portsUsage, { json: jsonOption('[{service, state, ports}]') }, { exits: PORTS_EXITS })
  const services = await allServices()

  if (services.length === 0)
    fail('no compose service here', 1)

  const rows = services.map(service => ({ service: key(service), state: service.state, ports: service.ports }))

  if (parsed.values.json === true) {
    printJson(rows)

    return 0
  }

  const colors = paint(process.stdout)

  console.log(table(rows.map(row => [row.service, colors[stateColor(row.state)](row.state), row.ports === '' ? colors.dim('none') : colors.cyan(row.ports)])))

  return 0
}
