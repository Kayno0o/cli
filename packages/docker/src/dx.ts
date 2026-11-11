import type { ExitRow } from '@kaynooo/cli-kit'
import type { Action, Service } from './stack'
import process from 'node:process'
import { loadKnown } from '@kaynooo/cli-env/files'
import { Redactor } from '@kaynooo/cli-env/redactor'
import { closest, fail, isInteractive, jsonOption, paint, parse, printJson, table, wholeNumber } from '@kaynooo/cli-kit'
import { byRecency, record, runs } from '@kaynooo/cli-kit/picker'
import { KEY_LABELS, KEYS, pickService } from './picker'
import { ACTIONS, allServices, commandFor, defaultAction, key, LOGS_TAIL, logsOf, serviceNamed, stateColor } from './stack'

const usage = `dx [service] [action]
dx -

Without a terminal (a script, a pipe, an agent) \`dx\` lists the services with their state, ports and image: that listing is the form to use there, \`--json\` giving the full record. On a terminal it picks one instead: enter opens its shell (or brings a stopped service up), ctrl-l follows its logs, ctrl-r restarts, ctrl-x stops and ctrl-b rebuilds it. The services last acted on come first, per folder.
\`dx -\` does the last action again, \`dx <service> [action]\` acts without the picker: \`shell\` (bash when the container has it), \`logs\` (the last ${LOGS_TAIL} lines, followed on a terminal and printed once without one; \`--tail N\` changes the count, \`--follow\` and \`--no-follow\` force either), \`restart\`, \`up\`, \`stop\` or \`build\` (up with a rebuild).
The services are the stack of this folder or its nearest parent, the ones of the child folders (keyed \`api/php\`), and stacks found only through their containers (keyed \`<project>:php\`).`

const EXITS: ExitRow[] = [['the code of the command it ran', 'a listing, a shell, logs, restart, up, stop or build'], [0, 'it listed the services'], [1, 'no compose service here or none by that name'], [2, 'a usage error']]

const options = {
  json: jsonOption('[{ key, project, name, state, status, ports, image }]'),
  tail: { type: 'string', description: `log lines shown by the logs action (${LOGS_TAIL})` },
  follow: { type: 'boolean', negative: 'print the logs once and exit instead of following them', description: 'follow the logs, the default on a terminal' },
} as const

function serviceTable(services: Service[]): string {
  const colors = paint(process.stdout)

  return table(services.map(service => [key(service), colors[stateColor(service.state)](service.state), colors.cyan(service.ports), colors.dim(service.image)]))
}

// This folder's service first, then the same name in a child folder.
function find(services: Service[], named: string): Service {
  const found = services.find(service => key(service) === named) ?? services.find(service => service.name === named)

  if (found !== undefined)
    return found

  const nearest = closest(named, services.map(key))

  return fail(`no service named ${named}${nearest === undefined ? '' : `, did you mean ${nearest}?`}`, 1)
}

// The rows term lists in place of the picker: what it types back for enter and for each key.
function listed(services: Service[]): unknown[] {
  return byRecency(services, runs('dx'), key).map(service => ({
    label: key(service),
    hint: [service.state, service.ports, service.image].filter(Boolean).join(' · '),
    typed: key(service),
    preview: ['--show', service.stack.dir, service.name, service.stack.project ?? ''],
    actions: Object.entries(KEYS).map(([pressed, action]) => ({ label: KEY_LABELS[pressed] ?? action, key: pressed, typed: `${key(service)} ${action}` })),
  }))
}

// The hidden flags term and the shell completions call, each printing and nothing more.
async function hidden(flag: string, rest: string[], services: Service[]): Promise<number | undefined> {
  if (flag === '--list') {
    console.log(JSON.stringify(listed(services)))

    return 0
  }

  // With the state as the description fish shows beside each name.
  if (flag === '--names') {
    console.log(services.map(service => `${key(service)}\t${service.state}`).join('\n'))

    return 0
  }

  if (flag === '--show') {
    const [dir = '.', name = '', project = ''] = rest
    const service = await serviceNamed(dir, name, project)

    if (service === undefined)
      return 0

    const colors = paint(process.stdout)

    console.log(`${colors[stateColor(service.state)](service.status || service.state)}  ${colors.dim(service.image)}${service.ports ? `  ${colors.cyan(service.ports)}` : ''}\n`)
    console.log(await logsOf(service.stack, name))

    return 0
  }

  return undefined
}

/** The logs command with its output piped through `ev redact`, for the picker that runs the words itself; refused when `ev` is missing rather than leaking the logs. */
export function maskedLogs(command: string[], evPath: string | null = Bun.which('ev')): string[] {
  if (evPath === null)
    fail('ev is not installed, so the logs would not be masked', 1)

  return ['sh', '-c', '"$@" | ev redact', 'sh', ...command]
}

/** Logs follow on a terminal and are printed once elsewhere, where a follow would hang a script or an agent until its timeout. */
export function followOrNot(follow: boolean | undefined, stdout: { isTTY?: boolean } = process.stdout): boolean {
  return follow ?? stdout.isTTY === true
}

export async function followMasked(command: string[]): Promise<number> {
  const redactor = new Redactor(await loadKnown())
  const decoder = new TextDecoder()
  const proc = Bun.spawn(command, { stdio: ['inherit', 'pipe', 'inherit'] })

  for await (const chunk of proc.stdout)
    process.stdout.write(redactor.push(decoder.decode(chunk, { stream: true })))

  process.stdout.write(redactor.end())

  return proc.exited
}

export async function dx(args: string[]): Promise<number> {
  const [flag = ''] = args

  if (flag === '--show' || flag === '--list' || flag === '--names') {
    const services = flag === '--show' ? [] : await allServices()

    if (services.length === 0 && flag !== '--show')
      fail('no compose service here', 1)

    return await hidden(flag, args.slice(1), services) ?? 0
  }

  // The protocol the tmux picker reads instead of running the command: its mode, the words typed back, and the command's words.
  const emit = flag === '--emit'
  const parsed = parse(emit ? args.slice(1) : args, usage, options, { allowNegative: true, exits: EXITS, replaces: 'docker compose exec <service> bash, logs -f and restart typed per service', examples: ['dx', ['dx php', 'a shell in php, or php brought up when stopped'], ['dx php logs', 'follow its logs on a terminal, print them once without one'], ['dx php logs --tail 50 --no-follow', 'the last 50 lines, then exit'], ['dx -', 'the last action again']] })
  const [named, asked] = parsed.positionals
  const services = await allServices()

  if (services.length === 0)
    fail('no compose service here', 1)

  let service: Service | undefined
  let action: Action | undefined

  if (named === undefined) {
    const interactive = isInteractive() && parsed.values.json !== true

    if (!interactive) {
      if (emit)
        fail('the picker needs a terminal', 1)

      if (parsed.values.json === true)
        printJson(services.map(each => ({ key: key(each), project: each.project, name: each.name, state: each.state, status: each.status, ports: each.ports, image: each.image })))
      else
        console.log(serviceTable(services))

      return 0
    }

    const picked = await pickService(byRecency(services, runs('dx'), key))

    if (picked === undefined)
      return 1

    service = picked.service
    action = KEYS[picked.key]
  }
  else if (named === '-') {
    const last = runs('dx')[0]

    service = last && services.find(candidate => key(candidate) === last.id)

    if (service === undefined)
      fail(last ? `${last.id} is gone` : 'nothing done here yet', 1)

    action = last!.args[0] as Action | undefined
  }
  else {
    service = find(services, named)

    if (asked !== undefined && !ACTIONS.includes(asked as Action))
      fail(`no action ${asked}, one of ${ACTIONS.join(', ')}`)

    action = asked as Action | undefined
  }

  const chosen = action ?? defaultAction(service)
  const { tail, follow } = parsed.values

  if ((tail !== undefined || follow !== undefined) && chosen !== 'logs')
    fail('--tail and --no-follow apply to the logs action: dx <service> logs')

  const command = await commandFor(service, chosen, { tail: tail === undefined ? undefined : wholeNumber(tail, 'tail', LOGS_TAIL, 0), follow: followOrNot(follow) })

  record('dx', { id: key(service), args: [chosen] })

  if (emit) {
    console.log(['run', action === undefined ? key(service) : `${key(service)} ${action}`, '', ...(chosen === 'logs' ? maskedLogs(command) : command).map(word => `=${word}`)].join('\n'))

    return 0
  }

  return chosen === 'logs' ? followMasked(command) : Bun.spawn(command, { stdio: ['inherit', 'inherit', 'inherit'] }).exited
}
