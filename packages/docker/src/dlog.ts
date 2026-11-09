import type { KnownSecrets } from '@kaynooo/cli-env/mask'
import type { ExitRow } from '@kaynooo/cli-kit'
import type { Container, Service } from './stack'
import process from 'node:process'
import { loadKnown } from '@kaynooo/cli-env/files'
import { maskLine, PEM_BEGIN, PEM_END } from '@kaynooo/cli-env/mask'
import { badUsage, configuredNumber, fail, jsonOption, paint, parse, printJson, stripAnsi, wholeNumber } from '@kaynooo/cli-kit'
import { truncate } from '@kaynooo/utils/text'
import { allServices, attempt, containers, key, stateColor } from './stack'

const usage = `dlog [service...]

One line per compose service with its state and health, then the last distinct error lines of the services that log some or are not healthy, repeats collapsed to one line with a count and secrets masked as redact does.
With service names, only those are read. The stacks are the ones dx lists: this folder's, its child folders' and the ones only their containers tell of.
\`--level warn\` keeps warnings too, \`--grep <regex>\` keeps the lines matching a case insensitive regex instead of the error words. What fails the exit is \`--fail-on\`: by default a service down, unhealthy or still starting, an error line or logs compose could not read, so it can gate a script; \`--fail-on down\` leaves out an old error line that \`--since\` has not aged out yet. A service that exited with code 0 (a migration, an init) is not down.`

const EXITS: ExitRow[] = [[0, 'nothing the --fail-on list names: every service is up and quiet'], [1, 'a service is down, unhealthy or still starting, logged a matching line or has logs compose could not read (as --fail-on keeps them), or there is no compose service here'], [2, 'a usage error']]

const FAIL_ON = ['down', 'unhealthy', 'errors'] as const

type FailOn = typeof FAIL_ON[number]

const options = {
  'lines': { type: 'string', short: 'n', default: '5', description: 'error lines kept per service' },
  'since': { type: 'string', default: '1h', description: 'how far back the logs are read (compose --since: 30m, 2h, a timestamp)' },
  'level': { type: 'string', choices: ['error', 'warn'], default: 'error', description: 'lowest level of the lines kept: error (the default) or warn, warnings too' },
  'grep': { type: 'string', description: 'keep the lines matching this regex, case insensitive, instead of the --level words' },
  'fail-on': { type: 'string', multiple: true, choices: FAIL_ON, description: 'what makes the exit 1, repeatable: down, unhealthy or errors (all three)' },
  'quiet': { type: 'boolean', short: 'q', description: 'print only the services --fail-on names, nothing when none needs a look' },
  'all': { type: 'boolean', short: 'a', description: 'the last log lines of a service with no error too' },
  'json': jsonOption('[{ key, state, health, status, errors: [{ line, count }], tail, down, unhealthy }]'),
} as const

// The count forms "0 errors" and "no errors" are left out, and an underscore keeps a config key such as error_reporting out too.
const ERROR = /(?<!\b(?:0|no) )\berrors?\b|\b(?:err|fatal|panic|critical|crit|traceback|failed|failure|refused|denied|timeout|timed out|oom|killed|oomkilled|segfault|segmentation fault|unhandled|uncaught)\b|\w*exception\b|\bERR_\w+|\bE(?:CONN|ADDR|NOENT|ACCES|PIPE|TIMEDOUT|HOSTUNREACH|NETUNREACH|MFILE|NOMEM|NOSPC)\w*/i
const WARNING = /\b(?:warn|warning|deprecated|deprecation)\b/i
const LEVELS = { error: ERROR, warn: new RegExp(`${ERROR.source}|${WARNING.source}`, 'i') }
const TAIL = configuredNumber('dlog', 'tail', 500)
const MAX_WIDTH = configuredNumber('dlog', 'width', 220)
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

/** The last `limit` distinct lines of a log matching `matches`, oldest first, each as its latest occurrence with how often its message came up, secrets masked. */
export function errorLines(log: string, limit: number, known?: KnownSecrets, matches: RegExp = ERROR): ErrorLine[] {
  const seen = new Map<string, ErrorLine>()

  for (const raw of log.split('\n')) {
    const line = stripAnsi(raw).trim()

    if (line === '' || !matches.test(line))
      continue

    const shared = shape(line)
    const before = seen.get(shared)

    // Re-inserted so the Map's order is the order of the latest occurrences.
    seen.delete(shared)
    seen.set(shared, { line: truncate(maskLine(line, known), MAX_WIDTH, { suffix: '…', includeSuffix: true }), count: (before?.count ?? 0) + 1 })
  }

  return [...seen.values()].slice(-limit)
}

export interface Health {
  /** `healthy`, `unhealthy`, `starting`, or empty when the container has no healthcheck. */
  health: string
  /** Whether the service is up and, when it has a healthcheck, healthy. */
  fine: boolean
}

/** Whether the service runs, or ended cleanly (exit code 0) as a migration does. */
export function isUp(state: string, container: Container | undefined): boolean {
  return state === 'running' || (state === 'exited' && container?.ExitCode === 0)
}

export function healthOf(state: string, container: Container | undefined): Health {
  const health = (container?.Health ?? '') || (STATUS_HEALTH.exec(container?.Status ?? '')?.[1]?.replace('health: ', '') ?? '')

  return { health, fine: isUp(state, container) && (health === '' || health === 'healthy') }
}

export interface Report {
  key: string
  state: string
  health: string
  status: string
  errors: ErrorLine[]
  tail: string[]
  /** The log came back as long as the tail limit, so older lines, errors among them, may have been cut. */
  windowFull: boolean
  /** The timestamp of the first line of a full window, when the log carries timestamps. */
  windowFrom: string | undefined
  /** Why compose could not list the service or read its logs. */
  unreadable: string | undefined
  fine: boolean
  /** Not running, and not a clean exit. */
  down: boolean
  /** Up, but unhealthy or still starting. */
  unhealthy: boolean
}

/** Whether the report fails the exit for what `failOn` names; logs compose could not read count as down and as errors alike. */
export function needsLook(report: Report, failOn: ReadonlySet<FailOn>): boolean {
  return (failOn.has('down') && (report.down || report.unreadable !== undefined))
    || (failOn.has('unhealthy') && report.unhealthy)
    || (failOn.has('errors') && (report.errors.length > 0 || report.unreadable !== undefined))
}

function matcherOf(level: keyof typeof LEVELS, grep: string | undefined): RegExp {
  if (grep === undefined)
    return LEVELS[level]

  try {
    return new RegExp(grep, 'i')
  }
  catch {
    return badUsage(`--grep takes a regex, ${grep} is not one`)
  }
}

/** Whether the log fills the tail limit, and the timestamp its first line starts at. */
export function windowOf(log: string, limit: number = TAIL): { full: boolean, from: string | undefined } {
  const lines = log.split('\n').filter(text => text.trim() !== '')

  if (lines.length < limit)
    return { full: false, from: undefined }

  return { full: true, from: lines[0]?.match(TIMESTAMP)?.[0] }
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

    if (report.windowFull)
      console.log(`  ${colors.yellow(`log window full: only the last ${TAIL} lines${report.windowFrom === undefined ? '' : `, from ${report.windowFrom}`}, were read; older errors may be missing`)}`)
  }
}

export async function dlog(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { exits: EXITS, replaces: 'docker compose ps, logs --tail | grep -i error and docker inspect for health', examples: ['dlog', ['dlog php db', 'only those services'], ['dlog -n 10 --since 15m', 'ten error lines of the last quarter of an hour'], ['dlog --level warn', 'warnings too'], ['dlog --grep "timeout|5\\d\\d"', 'the lines matching a regex'], ['dlog --fail-on down --fail-on unhealthy', 'a gate that ignores old errors'], ['dlog --json', 'the report as JSON']] })
  const limit = wholeNumber(parsed.values.lines, 'lines', 5)
  const matches = matcherOf(parsed.values.level === 'warn' ? 'warn' : 'error', parsed.values.grep)
  const failOn = new Set<FailOn>((parsed.values['fail-on'] ?? []).length > 0 ? parsed.values['fail-on'] ?? FAIL_ON : FAIL_ON)
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
    const window = windowOf(log)
    const lines = withoutKeys(log.split('\n'))
    const errors = errorLines(lines.join('\n'), limit, known, matches)
    const tail = parsed.values.all === true && errors.length === 0 ? lines.map(text => truncate(maskLine(stripAnsi(text).trim(), known), MAX_WIDTH, { suffix: '…', includeSuffix: true })).filter(Boolean).slice(-limit) : []

    return { key: key(service), state: service.state, health, status: service.status, errors, tail, windowFull: window.full, windowFrom: window.from, unreadable, fine, down: !isUp(service.state, container), unhealthy: isUp(service.state, container) && !fine }
  }))

  const down = reports.filter(report => needsLook(report, failOn))

  if (parsed.values.json === true)
    printJson(reports)
  else
    show(parsed.values.quiet === true ? down : reports)

  if (parsed.values.json !== true && down.length > 0)
    console.error(paint(process.stderr).dim(`${down.length} of ${reports.length} services need a look: ${down.map(report => report.key).join(', ')}`))

  return down.length > 0 ? 1 : 0
}
