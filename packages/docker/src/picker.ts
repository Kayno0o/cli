import type { Row } from '@kaynooo/cli-kit/picker'
import type { Action, Service } from './stack'
import process from 'node:process'
import { paint } from '@kaynooo/cli-kit'
import { heightFor, pick } from '@kaynooo/cli-kit/picker'
import { key, stateColor } from './stack'

export const KEYS: Record<string, Action> = { 'ctrl-l': 'logs', 'ctrl-r': 'restart', 'ctrl-x': 'stop', 'ctrl-b': 'build' }
export const KEY_LABELS: Record<string, string> = { 'ctrl-l': 'Logs', 'ctrl-r': 'Restart', 'ctrl-x': 'Stop', 'ctrl-b': 'Rebuild' }

// The hidden fields come back with the choice: folder, name, key, compose project.
function row(service: Service): Row {
  const colors = paint(process.stderr)
  const dir = service.stack.dir
  const project = service.stack.project
  const name = project === undefined ? service.name : `${colors.dim(`${project}:`)}${service.name}`

  return {
    hidden: [dir, service.name, key(service), project ?? ''],
    cells: [dir === '.' ? name : `${colors.dim(`${dir}/`)}${name}`, colors[stateColor(service.state)](service.state), colors.cyan(service.ports), colors.dim(service.image)],
  }
}

// The service picked and the key that picked it, enter's being empty; undefined on escape.
export async function pickService(services: Service[]): Promise<{ service: Service, key: string } | undefined> {
  const picked = await pick(services.map(row), {
    prompt: 'dx> ',
    header: 'enter shell or up, ctrl-l logs, ctrl-r restart, ctrl-x stop, ctrl-b rebuild',
    expect: Object.keys(KEYS),
    searched: 1,
    height: heightFor(services.length),
    preview: `${process.execPath} ${process.argv[1]} --show {1} {2} {4}`,
  })
  const service = services.find(candidate => key(candidate) === picked?.hidden[2])

  return picked === undefined || service === undefined ? undefined : { service, key: picked.key }
}
