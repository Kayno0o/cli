import type { Action, Service } from './stack'
import process from 'node:process'
import { paint } from '@kaynooo/cli-kit'
import { key, stateColor } from './stack'

export const KEYS: Record<string, Action> = { 'ctrl-l': 'logs', 'ctrl-r': 'restart', 'ctrl-x': 'stop', 'ctrl-b': 'build' }
export const KEY_LABELS: Record<string, string> = { 'ctrl-l': 'Logs', 'ctrl-r': 'Restart', 'ctrl-x': 'Stop', 'ctrl-b': 'Rebuild' }

// The fields fzf hands back after the visible ones, tab separated: folder, name, key, compose project.
function row(service: Service): { hidden: string[], cells: string[] } {
  const colors = paint(process.stderr)
  const dir = service.stack.dir
  const project = service.stack.project
  const name = project === undefined ? service.name : `${colors.dim(`${project}:`)}${service.name}`

  return {
    hidden: [dir, service.name, key(service), project ?? ''],
    cells: [dir === '.' ? name : `${colors.dim(`${dir}/`)}${name}`, colors[stateColor(service.state)](service.state), colors.cyan(service.ports), colors.dim(service.image)],
  }
}

// Every cell but the last padded to its column, one space short of the two between columns since a tab renders as one.
function table(rows: { hidden: string[], cells: string[] }[]): string {
  const widths = rows[0]?.cells.map((_, index) => Math.max(...rows.map(each => Bun.stringWidth(each.cells[index]!)))) ?? []

  return rows.map(each => [
    ...each.hidden,
    ...each.cells.map((cell, index) => (index === each.cells.length - 1 ? cell.trimEnd() : `${cell}${' '.repeat(widths[index]! + 1 - Bun.stringWidth(cell))}`)),
  ].join('\t')).join('\n')
}

// The service picked with fzf and the key that picked it, enter's being empty; undefined on escape.
export function pickService(services: Service[]): { service: Service, key: string } | undefined {
  const proc = Bun.spawnSync([
    'fzf',
    '--prompt',
    'dx> ',
    '--header',
    'enter shell or up, ctrl-l logs, ctrl-r restart, ctrl-x stop, ctrl-b rebuild',
    '--expect',
    Object.keys(KEYS).join(','),
    '--ansi',
    '--reverse',
    '--height',
    String(Math.max(15, Math.ceil((services.length + 4) / 0.6))),
    '--delimiter',
    '\t',
    '--with-nth',
    '5..',
    '--nth',
    '1',
    '--tabstop',
    '1',
    '--tiebreak',
    'chunk,index',
    '--preview',
    `${process.execPath} ${process.argv[1]} --show {1} {2} {4}`,
    '--preview-window',
    'down,40%',
  ], { stdin: new TextEncoder().encode(table(services.map(row))), stdout: 'pipe', stderr: 'inherit' })

  const [pressed = '', line] = proc.stdout.toString().split('\n')
  const keyed = line?.split('\t')[2]
  const service = services.find(candidate => key(candidate) === keyed)

  return service === undefined ? undefined : { service, key: pressed }
}
