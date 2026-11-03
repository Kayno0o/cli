import type { Action, Service } from './stack'
import process from 'node:process'
import { closest, fail, jsonOption, paint, parse, printJson } from '@kaynooo/cli-kit'
import { ACTIONS, allServices, commandFor, defaultAction, key } from './stack'

const usage = `dx [service] [action]

Without a service, lists the compose services here: the stack of this folder or its nearest parent, the ones of the child folders (keyed \`api/php\`), and stacks found only through their containers (keyed \`<project>:php\`).
With one, acts on it: \`shell\` (the default for a running service, bash when the container has it), \`logs\` (follows the last 200 lines), \`restart\`, \`up\`, \`stop\` or \`build\` (up with a rebuild). A stopped service has no shell, so it is brought up instead.

Exits with the code of the command it ran, 1 when there is no compose service here or none by that name.`

const options = {
  json: jsonOption('[{ key, project, name, state, status, ports, image }]'),
} as const

// Up in green, down in red, never created dimmed, anything on its way, restarting or paused, in yellow.
function stateColor(state: string): 'green' | 'red' | 'dim' | 'yellow' {
  if (state === 'running')
    return 'green'

  if (state === 'exited' || state === 'dead')
    return 'red'

  return state === 'none' ? 'dim' : 'yellow'
}

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

export async function dx(args: string[]): Promise<number> {
  const parsed = parse(args, usage, options, { replaces: 'docker compose exec <service> bash, logs -f and restart typed per service', examples: ['dx', ['dx php', 'a shell in php, or php brought up when stopped'], ['dx php logs', 'follow its logs']] })
  const [named, asked] = parsed.positionals
  const services = await allServices()

  if (services.length === 0)
    fail('no compose service here', 1)

  if (named === undefined) {
    if (parsed.values.json === true)
      printJson(services.map(service => ({ key: key(service), project: service.project, name: service.name, state: service.state, status: service.status, ports: service.ports, image: service.image })))
    else
      console.log(table(services))

    return 0
  }

  const service = find(services, named)

  if (asked !== undefined && !ACTIONS.includes(asked as Action))
    fail(`no action ${asked}, one of ${ACTIONS.join(', ')}`)

  const command = await commandFor(service, (asked as Action | undefined) ?? defaultAction(service))

  return Bun.spawn(command, { stdio: ['inherit', 'inherit', 'inherit'] }).exited
}
