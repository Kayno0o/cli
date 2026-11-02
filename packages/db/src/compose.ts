import { fail, runCommand } from '@kaynooo/cli-kit'

export type Engine = 'postgres' | 'mysql' | 'other'

export interface Service {
  name: string
  engine: Engine
  env: Record<string, string>
  // Every name the service answers to on its networks: the service name, the container name, aliases.
  names: string[]
  // Where the host reaches the server: a published port first, else the container's address on its network.
  host: string
  port: number
}

interface Publisher { URL?: string, TargetPort?: number, PublishedPort?: number }
interface PsRow { ID?: string, Service?: string, State?: string, Image?: string, Publishers?: Publisher[] | null }
interface Network { IPAddress?: string, Aliases?: string[] | null, DNSNames?: string[] | null }
interface PortBinding { HostIp?: string, HostPort?: string }
export interface Inspected {
  Id?: string
  Name?: string
  State?: { Running?: boolean }
  Config?: { Env?: string[] | null, Image?: string }
  NetworkSettings?: { Networks?: Record<string, Network> | null, Ports?: Record<string, PortBinding[] | null> | null }
}

const POSTGRES_PORT = 5432
const MYSQL_PORT = 3306
const POSTGRES_IMAGE = /(?:^|\/)(?:postgres|postgis|timescaledb)[\w.-]*(?::|$)/
const MYSQL_IMAGE = /(?:^|\/)(?:mysql|mariadb|percona)[\w.-]*(?::|$)/
const LOOPBACK = new Set(['', '0.0.0.0', '::', '127.0.0.1', '::1'])
const LEADING_SLASH = /^\//

// `docker compose ps --format json` prints one object per line since Compose 2.21, a single array before.
export function parsePs(text: string): PsRow[] {
  const trimmed = text.trim()

  if (trimmed === '')
    return []

  return trimmed.startsWith('[') ? JSON.parse(trimmed) as PsRow[] : trimmed.split('\n').map(line => JSON.parse(line) as PsRow)
}

function envOf(lines: string[]): Record<string, string> {
  return Object.fromEntries(lines.map((line) => {
    const at = line.indexOf('=')

    return at === -1 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)]
  }))
}

// The official images set PG_MAJOR or MYSQL_MAJOR / MARIADB_MAJOR in their environment, which a project's own image built FROM them keeps.
function engineOf(image: string, env: Record<string, string>): Engine {
  if ('PG_MAJOR' in env || 'POSTGRES_PASSWORD' in env || POSTGRES_IMAGE.test(image))
    return 'postgres'

  if ('MYSQL_MAJOR' in env || 'MARIADB_MAJOR' in env || 'MYSQL_ROOT_PASSWORD' in env || 'MARIADB_ROOT_PASSWORD' in env || MYSQL_IMAGE.test(image))
    return 'mysql'

  return 'other'
}

function describeContainer(name: string, image: string | undefined, publishers: Publisher[], container: Inspected): Service[] {
  const env = envOf(container.Config?.Env ?? [])
  const engine = engineOf(image ?? container.Config?.Image ?? '', env)
  const target = engine === 'mysql' ? MYSQL_PORT : POSTGRES_PORT
  const networks = Object.values(container.NetworkSettings?.Networks ?? {})
  const published = publishers.find(publisher => publisher.TargetPort === target && (publisher.PublishedPort ?? 0) > 0 && LOOPBACK.has(publisher.URL ?? ''))
  const address = networks.map(network => network.IPAddress ?? '').find(ip => ip !== '')
  const names = [name, (container.Name ?? '').replace(LEADING_SLASH, ''), ...networks.flatMap(network => [...network.Aliases ?? [], ...network.DNSNames ?? []])].filter(each => each !== '')

  if (published === undefined && address === undefined)
    return []

  return [{
    name,
    engine,
    env,
    names: [...new Set(names)],
    host: published === undefined ? address ?? '' : '127.0.0.1',
    port: published?.PublishedPort ?? target,
  }]
}

export function describeServices(rows: PsRow[], inspected: Inspected[]): Service[] {
  const byId = new Map(inspected.map(container => [container.Id ?? '', container]))

  return rows.flatMap((row) => {
    const container = [...byId.entries()].find(([id]) => row.ID !== undefined && row.ID !== '' && id.startsWith(row.ID))?.[1]

    if (container === undefined || row.Service === undefined)
      return []

    return describeContainer(row.Service, row.Image, row.Publishers ?? [], container)
  })
}

// What `docker inspect` gives as published ports: `{ "5432/tcp": [{ "HostIp": "0.0.0.0", "HostPort": "45000" }] }`.
function publishersOf(container: Inspected): Publisher[] {
  return Object.entries(container.NetworkSettings?.Ports ?? {}).flatMap(([port, bindings]) => (bindings ?? []).map(binding => ({ URL: binding.HostIp ?? '', TargetPort: Number.parseInt(port, 10), PublishedPort: Number.parseInt(binding.HostPort ?? '', 10) || 0 })))
}

// The container a docker inspect output describes, as a service named after the container.
export function describeNamedContainer(wanted: string, inspected: Inspected[]): Service {
  const [container] = inspected

  if (container === undefined)
    fail(`no container ${wanted}`)

  if (container.State?.Running === false)
    fail(`${wanted} is not running`)

  const name = (container.Name ?? '').replace(LEADING_SLASH, '') || wanted
  const [service] = describeContainer(name, undefined, publishersOf(container), container)

  if (service === undefined)
    fail(`${wanted} publishes no port and has no address on a network, so db cannot reach it`)

  return service
}

// A running container by name or id, wherever its compose project is.
export async function containerService(wanted: string): Promise<Service> {
  let inspect

  try {
    inspect = await runCommand(['docker', 'inspect', '--type', 'container', '--', wanted])
  }
  catch {
    fail('docker is not installed, so db cannot look a container up')
  }

  if (inspect.code !== 0)
    fail(`no container ${wanted}`)

  try {
    return describeNamedContainer(wanted, JSON.parse(stdoutOf(inspect.chunks)) as Inspected[])
  }
  catch (error) {
    if (error instanceof SyntaxError)
      fail(`docker inspect ${wanted} did not print JSON`)

    throw error
  }
}

function stdoutOf(chunks: { stream: string, data: Uint8Array }[]): string {
  return Buffer.concat(chunks.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.data)).toString()
}

// The running services of the compose project the working directory belongs to, as Compose finds it (this directory or a parent). Empty without docker or a project.
export async function composeServices(): Promise<Service[]> {
  let ps

  try {
    ps = await runCommand(['docker', 'compose', 'ps', '--format', 'json'])
  }
  catch {
    return []
  }

  try {
    const rows = ps.code === 0 ? parsePs(stdoutOf(ps.chunks)).filter(row => row.State === 'running' && row.ID !== undefined) : []

    if (rows.length === 0)
      return []

    const inspect = await runCommand(['docker', 'inspect', ...rows.map(row => row.ID ?? '')])

    return inspect.code === 0 ? describeServices(rows, JSON.parse(stdoutOf(inspect.chunks)) as Inspected[]) : []
  }
  catch {
    // Output that is not the JSON Compose prints is read as no project.
    return []
  }
}

// The database service to read: the one named, else the only Postgres, MySQL or MariaDB one running.
export function pickService(services: Service[], wanted: string | undefined): Service {
  const databases = services.filter(service => service.engine !== 'other')

  if (wanted !== undefined) {
    const named = services.find(service => service.name === wanted)

    if (named === undefined)
      fail(`no running service ${wanted} in this compose project${services.length === 0 ? '' : `, running: ${services.map(service => service.name).join(', ')}`}`)

    if (named.engine === 'other')
      fail(`${wanted} is no Postgres, MySQL or MariaDB service: db reads those only`)

    return named
  }

  if (databases.length > 1)
    fail(`several database services run here (${databases.map(service => service.name).join(', ')}): pick one with --service`)

  const [only] = databases

  if (only !== undefined)
    return only

  fail('no DATABASE_URL and no running Postgres, MySQL or MariaDB service in this compose project (docker compose ps, from this directory or a parent): put the URL in a .env file, name another key with --env, or ask for the stack to be started')
}

const PASSWORD_FILE_HINT = 'reads its password from a file inside the container: give the URL with --env instead'

function mysqlUrl(service: Service, authority: string): URL {
  const { env } = service
  const user = env.MYSQL_USER ?? env.MARIADB_USER
  const url = new URL(`mysql://${authority}`)

  if (user !== undefined) {
    if ((env.MYSQL_PASSWORD_FILE ?? env.MARIADB_PASSWORD_FILE) !== undefined && (env.MYSQL_PASSWORD ?? env.MARIADB_PASSWORD) === undefined)
      fail(`${service.name} ${PASSWORD_FILE_HINT}`)

    url.username = user
    url.password = env.MYSQL_PASSWORD ?? env.MARIADB_PASSWORD ?? ''
  }
  else {
    const root = env.MYSQL_ROOT_PASSWORD ?? env.MARIADB_ROOT_PASSWORD
    const isEmptyAllowed = ['MYSQL_ALLOW_EMPTY_PASSWORD', 'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD'].some(key => ['1', 'yes', 'true'].includes((env[key] ?? '').toLowerCase()))

    if (root === undefined && (env.MYSQL_ROOT_PASSWORD_FILE ?? env.MARIADB_ROOT_PASSWORD_FILE) !== undefined)
      fail(`${service.name} ${PASSWORD_FILE_HINT}`)

    if (root === undefined && !isEmptyAllowed)
      fail(`${service.name} has no MYSQL_USER or MYSQL_ROOT_PASSWORD (nor the MARIADB_ ones) in its environment, so db has no credentials for it: give the URL with --env instead`)

    url.username = 'root'
    url.password = root ?? ''
  }

  const database = env.MYSQL_DATABASE ?? env.MARIADB_DATABASE

  if (database !== undefined && database !== '')
    url.pathname = `/${database}`

  return url
}

// The URL the official image's environment describes, a password file aside.
export function serviceUrl(service: Service): string {
  const authority = `${service.host.includes(':') ? `[${service.host}]` : service.host}:${service.port}`

  if (service.engine === 'mysql')
    return mysqlUrl(service, authority).href

  if (service.env.POSTGRES_PASSWORD_FILE !== undefined && service.env.POSTGRES_PASSWORD === undefined)
    fail(`${service.name} ${PASSWORD_FILE_HINT}`)

  const user = service.env.POSTGRES_USER ?? 'postgres'
  const url = new URL(`postgres://${authority}`)

  url.username = user
  url.password = service.env.POSTGRES_PASSWORD ?? ''
  url.pathname = `/${service.env.POSTGRES_DB ?? user}`

  return url.href
}
