import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Exit } from '@kaynooo/cli-kit'
import { describe, expect, test } from 'bun:test'
import { describeServices, parsePs, pickPostgres, serviceUrl } from '../src/compose'

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

describe('parsePs', () => {
  test('reads one object per line and the older single array alike', () => {
    expect(parsePs('{"ID":"a"}\n{"ID":"b"}\n').map(row => row.ID)).toEqual(['a', 'b'])
    expect(parsePs('[{"ID":"a"}]').map(row => row.ID)).toEqual(['a'])
    expect(parsePs('\n')).toEqual([])
  })
})

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

describe('pickPostgres', () => {
  test('asks for --service when several run, and takes the one named', () => {
    expect(failure(() => pickPostgres(services, undefined))).toContain('several Postgres services run here (tilid-db, supervisor-db): pick one with --service')
    expect(pickPostgres(services, 'supervisor-db').name).toBe('supervisor-db')
  })

  test('takes the only one without asking', () => {
    expect(pickPostgres(services.slice(1), undefined).name).toBe('supervisor-db')
  })

  test('refuses a MySQL server, an unknown name and an empty project, saying why', () => {
    expect(failure(() => pickPostgres(services.slice(2), undefined))).toContain('only mysql runs here, a MySQL or MariaDB server')
    expect(failure(() => pickPostgres(services, 'php'))).toContain('php is no Postgres service')
    expect(failure(() => pickPostgres(services, 'nope'))).toContain('no running service nope in this compose project, running: tilid-db')
    expect(failure(() => pickPostgres([], undefined))).toContain('no DATABASE_URL and no running Postgres service')
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
  async function listed(dockerScript: string): Promise<unknown> {
    const bin = mkdtempSync(join(tmpdir(), 'db-tools-docker-'))

    writeFileSync(join(bin, 'docker'), dockerScript)
    chmodSync(join(bin, 'docker'), 0o755)

    const child = Bun.spawn([process.execPath, '-e', 'import { composeServices } from "./src/compose"; console.log(JSON.stringify(await composeServices()))'], { cwd: new URL('..', import.meta.url).pathname, env: { PATH: `${bin}:${process.env.PATH ?? ''}` }, stdout: 'pipe', stderr: 'pipe' })

    return JSON.parse(await new Response(child.stdout).text())
  }

  test('reads output that is not JSON as no project', async () => {
    expect(await listed('#!/bin/sh\necho "not json"\n')).toEqual([])
    expect(await listed('#!/bin/sh\ncase "$1" in compose) echo \'{"ID":"abc","Service":"database","State":"running"}\' ;; *) echo "oops" ;; esac\n')).toEqual([])
    expect(await listed('#!/bin/sh\necho null\n')).toEqual([])
  })
})
