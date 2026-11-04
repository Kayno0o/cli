import type { Action, Service } from './stack'
import process from 'node:process'
import { loadKnown } from '@kaynooo/cli-env/files'
import { Redactor } from '@kaynooo/cli-env/redactor'
import { closest, fail, jsonOption, paint, parse, printJson } from '@kaynooo/cli-kit'
import { byRecency, record, runs } from '@kaynooo/cli-kit/fzf'
import { KEY_LABELS, KEYS, pickService } from './picker'
import { ACTIONS, allServices, commandFor, defaultAction, key, logsOf, serviceNamed, stateColor } from './stack'

const usage = `dx [service] [action]
dx -

Without a service, picks one with fzf when it is installed and a terminal is attached: enter opens its shell (or brings a stopped service up), ctrl-l follows its logs, ctrl-r restarts, ctrl-x stops and ctrl-b rebuilds it. The services last acted on come first, per folder. Without fzf or a terminal it lists them instead.
\`dx -\` does the last action again, \`dx <service> [action]\` acts without the picker: \`shell\` (bash when the container has it), \`logs\` (follows the last 200 lines), \`restart\`, \`up\`, \`stop\` or \`build\` (up with a rebuild).
The services are the stack of this folder or its nearest parent, the ones of the child folders (keyed \`api/php\`), and stacks found only through their containers (keyed \`<project>:php\`).

Exits with the code of the command it ran, 1 when there is no compose service here or none by that name.`

const options = {
  json: jsonOption('[{ key, project, name, state, status, ports, image }]'),
} as const

function table(services: Service[]): string {
  const colors = paint(process.stdout)
  const keys = services.map(key)
  const width = Math.max(...keys.map(name => name.length))
  const states = Math.max(...services.map(service => service.state.length))

  return services.map((service, index) => [
    keys[index]!.padEnd(width),
    colors[stateColor(service.state)](service.state.padEnd(states)),
    colors.cyan(service.ports),
    colors.dim(service.image),
  ].join('  ').trimEnd()).join('\n')
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

/** The logs command with its output piped through `redact` when that is installed, for the picker that runs the words itself. */
export function maskedLogs(command: string[]): string[] {
  return Bun.which('redact') === null ? command : ['sh', '-c', '"$@" | redact', 'sh', ...command]
}

async function followMasked(command: string[]): Promise<number> {
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
  const parsed = parse(emit ? args.slice(1) : args, usage, options, { replaces: 'docker compose exec <service> bash, logs -f and restart typed per service', examples: ['dx', ['dx php', 'a shell in php, or php brought up when stopped'], ['dx php logs', 'follow its logs'], ['dx -', 'the last action again']] })
  const [named, asked] = parsed.positionals
  const services = await allServices()

  if (services.length === 0)
    fail('no compose service here', 1)

  let service: Service | undefined
  let action: Action | undefined

  if (named === undefined) {
    const interactive = process.stdin.isTTY && process.stderr.isTTY && parsed.values.json !== true

    if (!interactive || Bun.which('fzf') === null) {
      if (emit)
        fail('the picker needs a terminal and fzf', 1)

      if (interactive)
        console.error('fzf is not installed, listing the services instead')

      if (parsed.values.json === true)
        printJson(services.map(each => ({ key: key(each), project: each.project, name: each.name, state: each.state, status: each.status, ports: each.ports, image: each.image })))
      else
        console.log(table(services))

      return 0
    }

    const picked = pickService(byRecency(services, runs('dx'), key))

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
  const command = await commandFor(service, chosen)

  record('dx', { id: key(service), args: [chosen] })

  if (emit) {
    console.log(['run', action === undefined ? key(service) : `${key(service)} ${action}`, '', ...(chosen === 'logs' ? maskedLogs(command) : command).map(word => `=${word}`)].join('\n'))

    return 0
  }

  return chosen === 'logs' ? followMasked(command) : Bun.spawn(command, { stdio: ['inherit', 'inherit', 'inherit'] }).exited
}
