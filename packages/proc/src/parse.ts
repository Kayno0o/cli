export type Protocol = 'tcp' | 'udp'

export interface Socket {
  protocol: Protocol
  family: 4 | 6
  address: string
  port: number
  inode: number
  uid: number
}

// A TCP socket in LISTEN, or a UDP one bound and not connected.
const LISTENING: Record<Protocol, string> = { tcp: '0A', udp: '07' }
const WHITESPACE = /\s+/
const HEX_PAIR = /../g
const SOCKET_LINK = /^socket:\[(\d+)\]$/
const UNIT_SCOPE = /\.(?:service|scope)$/
const CONTAINER_ID = /(?:docker-|libpod-|\/docker\/)([0-9a-f]{64})/
const DOCKER_PORT = /:(\d+)(?:-(\d+))?->[\d-]+\/(tcp|udp)/

// One 32-bit word of an address, which /proc prints in the host's byte order (little endian), as its two hextets.
function word(hex: string): [number, number] {
  const bytes = (hex.match(HEX_PAIR) ?? []).reverse().map(byte => Number.parseInt(byte, 16))

  return [(bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!]
}

// An address as /proc/net/tcp and /proc/net/tcp6 write it: eight hex digits for IPv4, thirty-two for IPv6.
export function parseAddress(hex: string): string {
  if (hex.length === 8) {
    const [high, low] = word(hex)

    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }

  const hextets = (hex.match(/.{8}/g) ?? []).flatMap(word)

  if (hextets.length !== 8)
    return hex

  if (hextets.slice(0, 5).every(part => part === 0) && hextets[5] === 0xFFFF)
    return `::ffff:${hextets[6]! >> 8}.${hextets[6]! & 255}.${hextets[7]! >> 8}.${hextets[7]! & 255}`

  return compress(hextets)
}

// The textual form of eight hextets, the longest run of zeros (two or more) written `::`.
function compress(hextets: number[]): string {
  let best = { start: -1, length: 0 }
  let run = { start: 0, length: 0 }

  for (const [at, part] of hextets.entries()) {
    run = part === 0 ? { start: run.length === 0 ? at : run.start, length: run.length + 1 } : { start: 0, length: 0 }

    if (run.length > best.length)
      best = run
  }

  const text = (parts: number[]) => parts.map(part => part.toString(16)).join(':')

  if (best.length < 2)
    return text(hextets)

  return `${text(hextets.slice(0, best.start))}::${text(hextets.slice(best.start + best.length))}`
}

// The listening sockets of one /proc/net table, `family` telling its address width.
export function parseNetTable(text: string, protocol: Protocol, family: 4 | 6): Socket[] {
  const sockets: Socket[] = []

  for (const line of text.split('\n').slice(1)) {
    const columns = line.trim().split(WHITESPACE)
    const [address = '', port = ''] = (columns[1] ?? '').split(':')

    if (columns.length < 10 || columns[3] !== LISTENING[protocol])
      continue

    const number = Number.parseInt(port, 16)

    if (number === 0 || Number.isNaN(number))
      continue

    sockets.push({ protocol, family, address: parseAddress(address), port: number, uid: Number(columns[7]), inode: Number(columns[9]) })
  }

  return sockets
}

// The inode of a `socket:[12345]` fd link, undefined for any other.
export function socketInode(link: string): number | undefined {
  const match = SOCKET_LINK.exec(link)

  return match === null ? undefined : Number(match[1])
}

export interface Stat {
  comm: string
  state: string
  ppid: number
  pgrp: number
  session: number
  tty: number
  // Clock ticks after boot at which the process started.
  startTicks: number
  threads: number
}

// /proc/<pid>/stat. The command sits in parentheses and may hold spaces and parentheses itself, so the fields are counted from its last one.
export function parseStat(text: string): Stat | undefined {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')

  if (open === -1 || close < open)
    return undefined

  const rest = text.slice(close + 2).trim().split(WHITESPACE)
  const field = (number: number) => Number(rest[number - 3])

  if (rest.length < 20)
    return undefined

  return { comm: text.slice(open + 1, close), state: rest[0]!, ppid: field(4), pgrp: field(5), session: field(6), tty: field(7), threads: field(20), startTicks: field(22) }
}

// The `Key:\tvalue` lines of /proc/<pid>/status.
export function parseStatus(text: string): Map<string, string> {
  const fields = new Map<string, string>()

  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')

    if (colon > 0)
      fields.set(line.slice(0, colon), line.slice(colon + 1).trim())
  }

  return fields
}

// A status value in kB (`VmRSS:  1234 kB`) in bytes.
export function statusBytes(fields: Map<string, string>, key: string): number | undefined {
  const value = Number.parseInt(fields.get(key) ?? '', 10)

  return Number.isNaN(value) ? undefined : value * 1024
}

// The real user id of `Uid:\t1000\t1000\t1000\t1000`.
export function statusUid(fields: Map<string, string>): number | undefined {
  const value = Number.parseInt(fields.get('Uid') ?? '', 10)

  return Number.isNaN(value) ? undefined : value
}

export interface Limit {
  name: string
  soft: string
  hard: string
  units: string
}

const LIMIT_LINE = /^(\S+(?: \S+)*)\s{2,}(\S+)\s+(\S+)(?:\s+(\S+))?\s*$/

// /proc/<pid>/limits, whose columns are padded with spaces and whose names hold single ones.
export function parseLimits(text: string): Limit[] {
  const limits: Limit[] = []

  for (const line of text.split('\n').slice(1)) {
    const match = LIMIT_LINE.exec(line)

    if (match !== null)
      limits.push({ name: match[1]!, soft: match[2]!, hard: match[3]!, units: match[4] ?? '' })
  }

  return limits
}

// /proc/<pid>/cmdline: arguments joined by NUL, empty for a kernel thread.
export function parseCmdline(text: string): string[] {
  return text.split('\0').filter((_, at, parts) => at < parts.length - 1 || parts[at] !== '')
}

export function parseEnviron(text: string): [name: string, value: string][] {
  return parseCmdline(text).map((entry) => {
    const equals = entry.indexOf('=')

    return equals === -1 ? [entry, ''] : [entry.slice(0, equals), entry.slice(equals + 1)]
  })
}

export interface CgroupEntry {
  hierarchy: string
  controllers: string
  path: string
}

export function parseCgroup(text: string): CgroupEntry[] {
  return text.split('\n').filter(line => line !== '').map((line) => {
    const [hierarchy = '', controllers = '', ...path] = line.split(':')

    return { hierarchy, controllers, path: path.join(':') }
  })
}

// The innermost systemd unit or scope of a cgroup v2 path: `app-kitty-123.scope`, `docker-<id>.scope`, `foo.service`.
export function cgroupUnit(entries: CgroupEntry[]): string | undefined {
  const path = (entries.find(entry => entry.hierarchy === '0') ?? entries[0])?.path ?? ''

  return path.split('/').reverse().find(part => UNIT_SCOPE.test(part))
}

// The container id a cgroup path names, for Docker (`docker-<id>.scope` or `/docker/<id>`) and Podman (`libpod-<id>.scope`).
export function cgroupContainer(entries: CgroupEntry[]): string | undefined {
  for (const { path } of entries) {
    const match = CONTAINER_ID.exec(path)

    if (match !== null)
      return match[1]
  }

  return undefined
}

const SIZE = /^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i
const SIZE_UNITS: Record<string, number> = { '': 1024 ** 2, 'k': 1024, 'm': 1024 ** 2, 'g': 1024 ** 3, 't': 1024 ** 4 }

// A size such as `500M`, `1.5G` or `800k` in bytes, a bare number counting megabytes; undefined when it is none.
export function parseSize(text: string): number | undefined {
  const match = SIZE.exec(text.trim())

  return match === null ? undefined : Math.round(Number(match[1]) * SIZE_UNITS[match[2]!.toLowerCase()]!)
}

// The name behind a uid in /etc/passwd text.
export function userNameOf(passwd: string, uid: number): string | undefined {
  for (const line of passwd.split('\n')) {
    const [name, , id] = line.split(':')

    if (id === String(uid) && name !== undefined && name !== '')
      return name
  }

  return undefined
}

export interface Published {
  host: number
  protocol: Protocol
}

export interface Container {
  name: string
  project: string | undefined
  service: string | undefined
  published: Published[]
}

// The tab separated rows of `docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}'`; a published range (`8000-8002->80-82/tcp`) counts each of its host ports.
export function parseDockerPs(text: string): Container[] {
  const containers: Container[] = []

  for (const line of text.split('\n')) {
    const [name = '', ports = '', project = '', service = ''] = line.split('\t')

    if (name === '')
      continue

    const published: Published[] = []

    for (const entry of ports.split(',')) {
      const match = DOCKER_PORT.exec(entry)

      if (match === null)
        continue

      const first = Number(match[1])

      for (let host = first; host <= Number(match[2] ?? first); host++)
        published.push({ host, protocol: match[3] as Protocol })
    }

    containers.push({ name, project: project === '' ? undefined : project, service: service === '' ? undefined : service, published })
  }

  return containers
}
