import type { Service } from '../src/compose'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Exit } from '@kaynooo/cli-kit'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { describe, expect, test } from 'bun:test'
import { describeNamedContainer, describeServices, pickService, serviceUrl } from '../src/compose'

const temp = tempDirs()

const PS = [
  { ID: 'aaa111', Service: 'tilid-db', State: 'running', Image: 'postgres:17-alpine', Publishers: [{ URL: '0.0.0.0', TargetPort: 5432, PublishedPort: 45000 }] },
  { ID: 'bbb222', Service: 'supervisor-db', State: 'running', Image: 'acme-db', Publishers: [{ URL: '', TargetPort: 5432, PublishedPort: 0 }] },
  { ID: 'ccc333', Service: 'mysql', State: 'running', Image: 'mariadb:10.8', Publishers: null },
  { ID: 'ddd444', Service: 'php', State: 'running', Image: 'acme-php', Publishers: [] },
]

const INSPECT = [
  { Id: 'aaa111ffff', Name: '/tilid-tilid-db-1', Config: { Env: ['POSTGRES_USER=ticketing', 'POSTGRES_PASSWORD=p@ss/word', 'POSTGRES_DB=ticketing', 'PG_MAJOR=17'] }, NetworkSettings: { Networks: { tilid: { IPAddress: '172.30.0.5', Aliases: ['tilid-db'], DNSNames: ['tilid-tilid-db-1', 'tilid-db'] } } } },
  // A project image built FROM postgres keeps PG_MAJOR, and is reached on its network address when it publishes nothing.
  { Id: 'bbb222ffff', Name: '/tilid-supervisor-db-1', Config: { Env: ['PG_MAJOR=17'] }, NetworkSettings: { Networks: { tilid: { IPAddress: '172.30.0.9', Aliases: null, DNSNames: null } } } },
  { Id: 'ccc333ffff', Name: '/dorad_db', Config: { Env: ['MARIADB_MAJOR=10.8'] }, NetworkSettings: { Networks: { dorad: { IPAddress: '172.31.0.2' } } } },
  { Id: 'ddd444ffff', Name: '/php', Config: { Env: ['PHP_VERSION=8.4'] }, NetworkSettings: { Networks: { tilid: { IPAddress: '172.30.0.7' } } } },
]

const services = describeServices(PS, INSPECT)

function failure(run: () => unknown): string {
  try {
    run()
  }
  catch (error) {
    if (error instanceof Exit)
      return error.message
  }

  return ''
}

describe('describeServices', () => {
  test('tells the engines apart by image and environment', () => {
    expect(services.map(service => [service.name, service.engine])).toEqual([['tilid-db', 'postgres'], ['supervisor-db', 'postgres'], ['mysql', 'mysql'], ['php', 'other']])
  })

  test('reaches a published port on the loopback, else the network address', () => {
    expect(services[0]).toMatchObject({ host: '127.0.0.1', port: 45000 })
    expect(services[1]).toMatchObject({ host: '172.30.0.9', port: 5432 })
  })

  test('knows every name a service answers to', () => {
    expect(services[0]?.names).toEqual(['tilid-db', 'tilid-tilid-db-1'])
  })
})

describe('pickService', () => {
  test('asks for --service when several run, and takes the one named', () => {
    expect(failure(() => pickService(services, undefined))).toContain('several database services run here (tilid-db, supervisor-db, mysql): pick one with --service')
    expect(pickService(services, 'supervisor-db').name).toBe('supervisor-db')
    expect(pickService(services, 'mysql').engine).toBe('mysql')
  })

  test('takes the only one without asking, MySQL included', () => {
    expect(pickService(services.slice(1, 2), undefined).name).toBe('supervisor-db')
    expect(pickService(services.slice(2), undefined).name).toBe('mysql')
  })

  test('refuses a service that is no database, an unknown name and an empty project, saying why', () => {
    expect(failure(() => pickService(services, 'php'))).toContain('php is no Postgres, MySQL or MariaDB service')
    expect(failure(() => pickService(services, 'nope'))).toContain('no running service nope in this compose project, running: tilid-db')
    expect(failure(() => pickService([], undefined))).toContain('no DATABASE_URL and no running Postgres, MySQL or MariaDB service')
  })
})

describe('describeNamedContainer', () => {
  const container = {
    Id: 'eee555ffff',
    Name: '/booki-docker--shot-igesa-db-1',
    State: { Running: true },
    Config: { Image: 'postgres:17', Env: ['POSTGRES_USER=booki', 'POSTGRES_PASSWORD=s3cret-pw', 'POSTGRES_DB=booki_test'] },
    NetworkSettings: { Networks: { shot: { IPAddress: '172.40.0.3' } }, Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '45432' }, { HostIp: '::', HostPort: '45432' }], '8080/tcp': null } },
  }

  test('reads a container outside any compose project, reached on its published port', () => {
    const service = describeNamedContainer('booki-docker--shot-igesa-db-1', [container])

    expect(service).toMatchObject({ name: 'booki-docker--shot-igesa-db-1', engine: 'postgres', host: '127.0.0.1', port: 45432 })
    expect(serviceUrl(service)).toBe('postgres://booki:s3cret-pw@127.0.0.1:45432/booki_test')
  })

  test('falls back on the network address when nothing is published', () => {
    expect(describeNamedContainer('c', [{ ...container, NetworkSettings: { Networks: container.NetworkSettings.Networks, Ports: {} } }])).toMatchObject({ host: '172.40.0.3', port: 5432 })
  })

  test('refuses a stopped container, an unknown one and one with no address', () => {
    expect(failure(() => describeNamedContainer('c', [{ ...container, State: { Running: false } }]))).toBe('c is not running')
    expect(failure(() => describeNamedContainer('c', []))).toBe('no container c')
    expect(failure(() => describeNamedContainer('c', [{ ...container, NetworkSettings: { Networks: {}, Ports: {} } }]))).toContain('publishes no port')
  })

  test('refuses a container that runs no database', () => {
    expect(failure(() => describeNamedContainer('web', [{ ...container, Config: { Image: 'nginx:1.27', Env: [] } }]))).toBe('web is no Postgres, MySQL or MariaDB container: db reads those only')
  })

  test('never puts the password in a message', () => {
    expect(failure(() => serviceUrl({ ...describeNamedContainer('c', [container]), env: { POSTGRES_PASSWORD_FILE: '/run/secrets/pw' } }))).not.toContain('s3cret-pw')
  })
})

describe('serviceUrl for MySQL and MariaDB', () => {
  const base: Service = { name: 'db', engine: 'mysql', env: {}, names: ['db'], host: '127.0.0.1', port: 33060 }

  test('reads MYSQL_USER, MYSQL_PASSWORD and MYSQL_DATABASE', () => {
    const url = new URL(serviceUrl({ ...base, env: { MYSQL_USER: 'battena', MYSQL_PASSWORD: 'p@ss', MYSQL_DATABASE: 'battena_test', MYSQL_ROOT_PASSWORD: 'rootpw' } }))

    expect([url.protocol, url.username, decodeURIComponent(url.password), url.host, url.pathname]).toEqual(['mysql:', 'battena', 'p@ss', '127.0.0.1:33060', '/battena_test'])
  })

  test('reads the MARIADB_ equivalents', () => {
    const url = new URL(serviceUrl({ ...base, env: { MARIADB_USER: 'app', MARIADB_PASSWORD: 'pw1', MARIADB_DATABASE: 'app' } }))

    expect([url.username, url.password, url.pathname]).toEqual(['app', 'pw1', '/app'])
  })

  test('falls back on root and its password, without a database', () => {
    const url = new URL(serviceUrl({ ...base, env: { MYSQL_ROOT_PASSWORD: 'rootpw' } }))

    expect([url.username, url.password, url.pathname]).toEqual(['root', 'rootpw', ''])
    expect(new URL(serviceUrl({ ...base, env: { MARIADB_ROOT_PASSWORD: 'maria' } })).password).toBe('maria')
    expect(new URL(serviceUrl({ ...base, env: { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes' } })).username).toBe('root')
  })

  test('refuses without credentials or with a password file, never printing a password', () => {
    expect(failure(() => serviceUrl(base))).toContain('has no MYSQL_USER or MYSQL_ROOT_PASSWORD')
    expect(failure(() => serviceUrl({ ...base, env: { MYSQL_USER: 'u', MYSQL_PASSWORD_FILE: '/run/secrets/pw' } }))).toContain('reads its password from a file')
    expect(failure(() => serviceUrl({ ...base, env: { MARIADB_ROOT_PASSWORD_FILE: '/run/secrets/pw' } }))).toContain('reads its password from a file')
  })
})

describe('serviceUrl', () => {
  test('builds the URL from the official image\'s variables, the password encoded', () => {
    const url = new URL(serviceUrl(services[0]!))

    expect([url.username, decodeURIComponent(url.password), url.host, url.pathname]).toEqual(['ticketing', 'p@ss/word', '127.0.0.1:45000', '/ticketing'])
  })

  test('falls back on the image\'s defaults', () => {
    expect(serviceUrl(services[1]!)).toBe('postgres://postgres@172.30.0.9:5432/postgres')
  })

  test('refuses a password kept in a file', () => {
    expect(failure(() => serviceUrl({ ...services[1]!, env: { POSTGRES_PASSWORD_FILE: '/run/secrets/pw' } }))).toContain('reads its password from a file')
  })
})

describe('composeServices', () => {
  // Runs in a child, as Bun looks docker up on the PATH the process started with.
  async function listed(dockerScript: string, expression = 'composeServices()'): Promise<unknown> {
    const bin = temp('cli-db-docker-')

    writeFileSync(join(bin, 'docker'), dockerScript)
    chmodSync(join(bin, 'docker'), 0o755)

    const child = Bun.spawn([process.execPath, '-e', `import { composeServices, containerService } from "./src/compose"; console.log(JSON.stringify(await ${expression}))`], { cwd: new URL('..', import.meta.url).pathname, env: { PATH: `${bin}:${process.env.PATH ?? ''}` }, stdout: 'pipe', stderr: 'pipe' })

    return JSON.parse(await new Response(child.stdout).text())
  }

  test('looks a container up by name with docker inspect, a stub standing for docker', async () => {
    const inspected = JSON.stringify([{ Id: 'abc', Name: '/booki-db-1', State: { Running: true }, Config: { Image: 'mariadb:11', Env: ['MARIADB_ROOT_PASSWORD=rootpw'] }, NetworkSettings: { Networks: {}, Ports: { '3306/tcp': [{ HostIp: '127.0.0.1', HostPort: '33061' }] } } }])
    const script = `#!/bin/sh\ncase "$1 $2 $3 $4" in "inspect --type container --") [ "$5" = booki-db-1 ] && echo '${inspected}' ;; *) exit 1 ;; esac\n`

    expect(await listed(script, 'containerService("booki-db-1")')).toMatchObject({ name: 'booki-db-1', engine: 'mysql', host: '127.0.0.1', port: 33061 })
  })

  test('reads output that is not JSON as no project', async () => {
    expect(await listed('#!/bin/sh\necho "not json"\n')).toEqual([])
    expect(await listed('#!/bin/sh\ncase "$1" in compose) echo \'{"ID":"abc","Service":"database","State":"running"}\' ;; *) echo "oops" ;; esac\n')).toEqual([])
    expect(await listed('#!/bin/sh\necho null\n')).toEqual([])
  })
})
