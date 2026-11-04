import type { KnownSecrets } from '@kaynooo/cli-env/mask'
import type { Container, Service } from './stack'
import process from 'node:process'
import { loadKnown } from '@kaynooo/cli-env/files'
import { maskLine, PEM_BEGIN, PEM_END } from '@kaynooo/cli-env/mask'
import { fail, jsonOption, paint, parse, printJson, stripAnsi, wholeNumber } from '@kaynooo/cli-kit'
import { allServices, attempt, containers, key, stateColor } from './stack'

const usage = `dlog [service...]

One line per compose service with its state and health, then the last distinct error lines of the services that log some or are not healthy, repeats collapsed to one line with a count and secrets masked as redact does.
With service names, only those are read. The stacks are the ones dx lists: this folder's, its child folders' and the ones only their containers tell of.

Exits 0 when every service is up and quiet, 1 when one is down, unhealthy or still starting, logged an error or has logs compose could not read, so it can gate a script, 1 too when there is no compose service here. A service that exited with code 0 (a migration, an init) is not down.`

const options = {
  lines: { type: 'string', short: 'n', default: '5', description: 'error lines kept per service' },
  since: { type: 'string', default: '1h', description: 'how far back the logs are read (compose --since: 30m, 2h, a timestamp)' },
  all: { type: 'boolean', short: 'a', description: 'the last log lines of a service with no error too' },
  json: jsonOption('[{ key, state, health, status, errors: [{ line, count }], tail }]'),
} as const

const ERROR = /\b(?:error|err|fatal|exception|panic|critical|crit|traceback|failed|failure|refused|denied|timeout|timed out|oom|killed)\b/i
const TAIL = 500
const MAX_WIDTH = 220
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}[/-][A-Za-z]{3}[/-]\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/g
const IDENTIFIER = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|0x[0-9a-f]+|[0-9a-f]{12,})\b/gi
const NUMBER = /\d+/g
const STATUS_HEALTH = /\((healthy|unhealthy|health: starting)\)/
const LEADING_BRACKETS = /^(?:\[\s*\]|\s)+/

export interface ErrorLine {
  line: string
  count: number
}

/** The line two occurrences of the same message share: no timestamp, id or number. */
function shape(line: string): string {
  return line.replace(TIMESTAMP, '').replace(IDENTIFIER, '#').replace(NUMBER, '#').replace(LEADING_BRACKETS, '').trim()
}

function clip(line: string): string {
  return line.length > MAX_WIDTH ? `${line.slice(0, MAX_WIDTH - 1)}…` : line
}

/** The last `limit` distinct error lines of a log, oldest first, each as its latest occurrence with how often its message came up, secrets masked. */
export function errorLines(log: string, limit: number, known?: KnownSecrets): ErrorLine[] {
  const seen = new Map<string, ErrorLine>()

  for (const raw of log.split('\n')) {
    const line = stripAnsi(raw).trim()

    if (line === '' || !ERROR.test(line))
      continue

    const shared = shape(line)
    const before = seen.get(shared)

    // Re-inserted so the Map's order is the order of the latest occurrences.
    seen.delete(shared)
    seen.set(shared, { line: clip(maskLine(line, known)), count: (before?.count ?? 0) + 1 })
  }

  return [...seen.values()].slice(-limit)
}

export interface Health {
  /** `healthy`, `unhealthy`, `starting`, or empty when the container has no healthcheck. */
  health: string
  /** Whether the service is up and, when it has a healthcheck, healthy. */
  fine: boolean
}

export function healthOf(state: string, container: Container | undefined): Health {
  const health = (container?.Health ?? '') || (STATUS_HEALTH.exec(container?.Status ?? '')?.[1]?.replace('health: ', '') ?? '')
  const finished = state === 'exited' && container?.ExitCode === 0

  return { health, fine: (state === 'running' || finished) && (health === '' || health === 'healthy') }
}

export interface Report {
  key: string
  state: string
  health: string
  status: string
  errors: ErrorLine[]
  tail: string[]
  /** Why compose could not list the service or read its logs. */
  unreadable: string | undefined
  fine: boolean
}

async function read(service: Service, since: string): Promise<{ log: string, container: Container | undefined, unreadable: string | undefined }> {
  const [ps, logs] = await Promise.all([
    attempt(service.stack, ['ps', '--all', '--format', 'json', service.name]),
    attempt(service.stack, ['logs', '--no-color', '--no-log-prefix', `--tail=${TAIL}`, `--since=${since}`, service.name]),
  ])

  return { log: logs.text, container: containers(ps.text)[0], unreadable: ps.error ?? logs.error }
}

/** The lines of a log without the body of a private key. */
export function withoutKeys(lines: string[]): string[] {
  let inKey = false

  return lines.filter((text) => {
    const opens = PEM_BEGIN.test(text)
    const hidden = inKey || opens

    inKey = (inKey || opens) && !PEM_END.test(text)

    return !hidden
  })
}

function line(report: Report): string {
  const colors = paint(process.stdout)
  const status = report.status.replace(STATUS_HEALTH, '').trim()
  const detail = [report.health, status].filter(Boolean).join(' · ')

  return `${report.key.padEnd(24)} ${colors[stateColor(report.state)](report.state.padEnd(9))} ${colors.dim(detail)}`.trimEnd()
}

function show(reports: Report[]): void {
  const colors = paint(process.stdout)

  for (const report of reports) {
    console.log(line(report))

    if (report.unreadable !== undefined)
      console.log(`  ${colors.red(`logs unavailable: ${report.unreadable}`)}`)

    for (const { line: text, count } of report.errors)
      console.log(`  ${colors.red(text)}${count > 1 ? colors.dim(` ×${count}`) : ''}`)

    for (const text of report.tail)
      console.log(`  ${colors.dim(text)}`)
  }
}

export async function dlog(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { replaces: 'docker compose ps, logs --tail | grep -i error and docker inspect for health', examples: ['dlog', ['dlog php db', 'only those services'], ['dlog -n 10 --since 15m', 'ten error lines of the last quarter of an hour'], ['dlog --json', 'the report as JSON']] })
  const limit = wholeNumber(parsed.values.lines, 'lines', 5)
  const known = await loadKnown()

  const services = await allServices()

  if (services.length === 0)
    fail('no compose service here', 1)

  const wanted = parsed.positionals
  const unknown = wanted.filter(name => !services.some(service => key(service) === name || service.name === name))

  if (unknown.length > 0)
    fail(`no service named ${unknown.join(', ')}`, 1)

  const chosen = wanted.length === 0 ? services : services.filter(service => wanted.includes(key(service)) || wanted.includes(service.name))
  const reports: Report[] = await Promise.all(chosen.map(async (service) => {
    const { log, container, unreadable } = await read(service, parsed.values.since)
    const { health, fine } = healthOf(service.state, container)
    const lines = withoutKeys(log.split('\n'))
    const errors = errorLines(lines.join('\n'), limit, known)
    const tail = parsed.values.all === true && errors.length === 0 ? lines.map(text => clip(maskLine(stripAnsi(text).trim(), known))).filter(Boolean).slice(-limit) : []

    return { key: key(service), state: service.state, health, status: service.status, errors, tail, unreadable, fine }
  }))

  if (parsed.values.json === true)
    printJson(reports)
  else
    show(reports)

  const down = reports.filter(report => !report.fine || report.unreadable !== undefined || report.errors.length > 0)

  if (parsed.values.json !== true && down.length > 0)
    console.error(paint(process.stderr).dim(`${down.length} of ${reports.length} services need a look: ${down.map(report => report.key).join(', ')}`))

  return down.length > 0 ? 1 : 0
}
