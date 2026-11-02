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
interface Inspected { Id?: string, Name?: string, Config?: { Env?: string[] | null, Image?: string }, NetworkSettings?: { Networks?: Record<string, Network> | null } }

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

export function describeServices(rows: PsRow[], inspected: Inspected[]): Service[] {
  const byId = new Map(inspected.map(container => [container.Id ?? '', container]))

  return rows.flatMap((row) => {
    const container = [...byId.entries()].find(([id]) => row.ID !== undefined && row.ID !== '' && id.startsWith(row.ID))?.[1]

    if (container === undefined || row.Service === undefined)
      return []

    const env = envOf(container.Config?.Env ?? [])
    const engine = engineOf(row.Image ?? container.Config?.Image ?? '', env)
    const target = engine === 'mysql' ? MYSQL_PORT : POSTGRES_PORT
    const networks = Object.values(container.NetworkSettings?.Networks ?? {})
    const published = (row.Publishers ?? []).find(publisher => publisher.TargetPort === target && (publisher.PublishedPort ?? 0) > 0 && LOOPBACK.has(publisher.URL ?? ''))
    const address = networks.map(network => network.IPAddress ?? '').find(ip => ip !== '')
    const names = [row.Service, (container.Name ?? '').replace(LEADING_SLASH, ''), ...networks.flatMap(network => [...network.Aliases ?? [], ...network.DNSNames ?? []])].filter(name => name !== '')

    if (published === undefined && address === undefined)
      return []

    return [{
      name: row.Service,
      engine,
      env,
      names: [...new Set(names)],
      host: published === undefined ? address ?? '' : '127.0.0.1',
      port: published?.PublishedPort ?? target,
    }]
  })
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

// The Postgres service to read: the one named, else the only one running.
export function pickPostgres(services: Service[], wanted: string | undefined): Service {
  const postgres = services.filter(service => service.engine === 'postgres')

  if (wanted !== undefined) {
    const named = services.find(service => service.name === wanted)

    if (named === undefined)
      fail(`no running service ${wanted} in this compose project${services.length === 0 ? '' : `, running: ${services.map(service => service.name).join(', ')}`}`)

    if (named.engine !== 'postgres')
      fail(`${wanted} is no Postgres service: db reads Postgres only`)

    return named
  }

  if (postgres.length > 1)
    fail(`several Postgres services run here (${postgres.map(service => service.name).join(', ')}): pick one with --service`)

  const [only] = postgres

  if (only !== undefined)
    return only

  const mysql = services.filter(service => service.engine === 'mysql')

  if (mysql.length > 0)
    fail(`only ${mysql.map(service => service.name).join(', ')} run${mysql.length === 1 ? 's' : ''} here, a MySQL or MariaDB server: db reads Postgres only`)

  fail('no DATABASE_URL and no running Postgres service in this compose project (docker compose ps, from this directory or a parent): put the URL in a .env file, name another key with --env, or ask for the stack to be started')
}

// The URL the official image's environment describes, a password file aside.
export function serviceUrl(service: Service): string {
  if (service.env.POSTGRES_PASSWORD_FILE !== undefined && service.env.POSTGRES_PASSWORD === undefined)
    fail(`${service.name} reads its password from a file inside the container: give the URL with --env instead`)

  const user = service.env.POSTGRES_USER ?? 'postgres'
  const url = new URL(`postgres://${service.host.includes(':') ? `[${service.host}]` : service.host}:${service.port}`)

  url.username = user
  url.password = service.env.POSTGRES_PASSWORD ?? ''
  url.pathname = `/${service.env.POSTGRES_DB ?? user}`

  return url.href
}
