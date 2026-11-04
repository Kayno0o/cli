import type { Container, Protocol, Socket } from './parse'
import type { ProcInfo } from './read'
import { basename } from 'node:path'
import process from 'node:process'
import { badUsage, duration, fail, jsonOption, paint, parse, printJson, table, truncate, wholeNumber } from '@kaynooo/cli-kit'
import { confirm } from '@kaynooo/cli-kit/prompt'
import { dockerContainers } from './docker'
import { protectionOf, terminate } from './kill'
import { maskArgs } from './mask'
import { ancestry, readSockets, snapshot, socketOwners } from './read'

const usage = `ports [port]

Lists what listens on this machine, TCP and UDP over IPv4 and IPv6, one row per port with its bound address, the owning process, its command and its working directory. A port Docker publishes is held by docker-proxy, and shows as its compose project and service when docker is installed; the owner of a socket of another user cannot be read and shows as -.
\`ports <port>\` keeps that port alone and exits 1 when nothing listens on it.
\`ports <port> --kill\` stops its owner with SIGTERM, and with --force SIGKILL once --grace has passed, after asking on a terminal unless --yes is given. It refuses processes of other users, pid 1, this command and its ancestors, and docker-proxy, for which it names the container to stop instead.

Exits 0 when it listed or stopped, 1 when nothing listens on the given port or the owner could not be stopped, 2 on a usage error.`

const options = {
  json: jsonOption('[{ port, protocol, addresses, pid, command, cwd, container }]'),
  kill: { type: 'boolean', description: 'stop the owner of the given port' },
  force: { type: 'boolean', description: 'with --kill, SIGKILL what SIGTERM did not stop within --grace' },
  yes: { type: 'boolean', short: 'y', description: 'with --kill, do not ask first' },
  grace: { type: 'string', description: 'with --force, how long SIGTERM gets before SIGKILL (5s)' },
} as const

export interface PortRow {
  port: number
  protocol: Protocol
  addresses: string[]
  pid: number | undefined
  command: string | undefined
  cwd: string | undefined
  uid: number | undefined
  container: { name: string, project: string | undefined, service: string | undefined } | undefined
}

// One row per protocol, port and owner; IPv4 and IPv6 sockets of the same process merge. A socket whose owner is not readable, or is docker-proxy, takes the container publishing its port.
export function buildRows(sockets: Socket[], owners: Map<number, number>, procs: Map<number, ProcInfo>, containers: Container[]): PortRow[] {
  const rows = new Map<string, PortRow>()

  for (const socket of sockets) {
    const pid = owners.get(socket.inode)
    const proc = pid === undefined ? undefined : procs.get(pid)
    const key = `${socket.protocol}/${socket.port}/${pid ?? 'unknown'}`
    const row = rows.get(key)

    if (row !== undefined) {
      if (!row.addresses.includes(socket.address))
        row.addresses.push(socket.address)

      continue
    }

    const held = proc === undefined || proc.comm === 'docker-proxy'
    const container = held ? containers.find(candidate => candidate.published.some(port => port.host === socket.port && port.protocol === socket.protocol)) : undefined

    rows.set(key, {
      port: socket.port,
      protocol: socket.protocol,
      addresses: [socket.address],
      pid,
      command: proc === undefined ? undefined : maskArgs([basename(proc.args[0] ?? proc.comm), ...proc.args.slice(1)]).join(' '),
      cwd: proc?.cwd,
      uid: proc?.uid ?? socket.uid,
      container: container === undefined ? undefined : { name: container.name, project: container.project, service: container.service },
    })
  }

  return [...rows.values()].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol) || (a.pid ?? 0) - (b.pid ?? 0))
}

function containerLabel(container: NonNullable<PortRow['container']>): string {
  return container.project === undefined ? container.name : `${container.project}/${container.service ?? container.name}`
}

// Why the owner of a row cannot be stopped, undefined when it can.
export function refusal(row: PortRow, proc: ProcInfo | undefined, guard: { uid: number, mine: ReadonlySet<number> }): string | undefined {
  if (row.container !== undefined && (proc === undefined || proc.comm === 'docker-proxy'))
    return `published by the container ${row.container.name} (${containerLabel(row.container)}): stop it with \`docker stop ${row.container.name}\``

  if (proc === undefined || row.pid === undefined)
    return 'its owner is not readable (another user\'s process): rerun as that user'

  const reason = protectionOf(proc, guard)

  return reason === undefined ? undefined : `pid ${row.pid} is ${reason}`
}

function render(rows: PortRow[]): string {
  const colors = paint(process.stdout)
  const cells = rows.map(row => [
    colors.cyan(String(row.port)),
    row.protocol,
    row.addresses.join(', '),
    row.pid === undefined ? '-' : String(row.pid),
    row.container === undefined ? truncate(row.command ?? '-', 60) : colors.yellow(`docker ${containerLabel(row.container)}`),
    colors.dim(row.cwd ?? '-'),
  ])

  return table([['PORT', 'PROTO', 'ADDRESS', 'PID', 'COMMAND', 'CWD'], ...cells], { header: true })
}

async function stop(port: number, rows: PortRow[], procs: Map<number, ProcInfo>, values: { force?: boolean | undefined, yes?: boolean | undefined, grace?: string | undefined }): Promise<number> {
  const guard = { uid: process.getuid?.() ?? -1, mine: new Set(ancestry(process.pid, procs)) }
  const targets = new Map<number, PortRow>()

  for (const row of rows) {
    const reason = refusal(row, row.pid === undefined ? undefined : procs.get(row.pid), guard)

    if (reason !== undefined)
      console.error(`port ${port}: ${reason}`)
    else if (row.pid !== undefined)
      targets.set(row.pid, row)
  }

  if (targets.size === 0)
    return 1

  const names = [...targets].map(([pid, row]) => `${pid} (${truncate(row.command ?? '', 40)})`).join(', ')

  if (values.yes !== true) {
    if (!process.stdin.isTTY)
      fail(`stopping ${names} needs a terminal to ask on: pass --yes`, 2)

    if (await confirm(`Stop ${names}?`, { default: false }) !== true)
      return 1
  }

  const outcome = await terminate([...targets.keys()], { escalate: values.force === true, graceMs: duration(values.grace, 'grace', 5000) })

  for (const pid of [...outcome.terminated, ...outcome.killed])
    console.log(`stopped ${pid}${outcome.killed.includes(pid) ? ' (SIGKILL)' : ''}`)

  for (const pid of outcome.survived)
    console.error(`${pid} is still running${values.force === true ? '' : ', pass --force to SIGKILL it'}`)

  return outcome.survived.length === 0 ? 0 : 1
}

export async function ports(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, usage, options, {
    positionals: ['[port]'],
    replaces: 'ss -ltnp | grep, lsof -i, fuser -k and lookups of docker-proxy by hand',
    examples: [
      ['ports', 'every listening port with its owner'],
      ['ports 3000', 'who holds 3000, exit 1 when nobody does'],
      ['ports 3000 --kill --yes', 'stop it'],
      'ports --json',
    ],
  })
  const [given] = positionals
  const port = given === undefined ? undefined : wholeNumber(given, '<port>', 0)

  if (port !== undefined && port > 65_535)
    badUsage(`<port> takes a whole number from 1 to 65535, not ${given}`)

  if (values.kill === true && port === undefined)
    badUsage('--kill takes the port to free: ports <port> --kill')

  const [sockets, owners, procs] = await Promise.all([readSockets(), socketOwners(), snapshot('/proc', uid => uid === process.getuid?.())])
  const byPid = new Map(procs.map(proc => [proc.pid, proc]))
  const wanted = sockets.filter(socket => port === undefined || socket.port === port)
  const needsDocker = wanted.some((socket) => {
    const pid = owners.get(socket.inode)

    return pid === undefined || byPid.get(pid)?.comm === 'docker-proxy'
  })
  const rows = buildRows(wanted, owners, byPid, needsDocker ? await dockerContainers() : [])

  if (port !== undefined && rows.length === 0) {
    console.error(`nothing listens on port ${port}`)

    return 1
  }

  if (values.kill === true && port !== undefined)
    return stop(port, rows, byPid, values)

  if (values.json === true) {
    printJson(rows)

    return 0
  }

  console.log(render(rows))

  const unknown = rows.filter(row => row.pid === undefined && row.container === undefined).length

  if (unknown > 0)
    console.error(paint(process.stderr).dim(`${unknown} ${unknown === 1 ? 'port has' : 'ports have'} an owner this user cannot read, shown as -`))

  return 0
}
