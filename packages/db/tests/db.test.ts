import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { afterAll, describe, expect, test } from 'bun:test'

const temp = tempDirs()

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const IMAGE = 'postgres:18-alpine'
// A Postgres the suite may create and drop its own database in, as CI starts the runner image's: set only there, so the tests never touch an existing database.
const SERVER = process.env.DB_TOOLS_TEST_SERVER
const PASSWORD = SERVER === undefined ? 'pw-never-printed-9731' : decodeURIComponent(new URL(SERVER).password)
const CONTAINER = `cli-db-test-${process.pid}`
const DATABASE = `db_tools_test_${process.pid}`
const PORT = /:(\d+)$/m
const SCHEMA = `
  create table users (id serial primary key, name text not null, email text, password_hash text);
  insert into users (name, email, password_hash) select 'user' || i, 'u' || i || '@x.io', 'hash' || i from generate_series(1, 150) i;
  create table audit (id serial primary key, note text);
  create view user_names as select name from users;
`

// The throwaway database, set by onServer or inDocker.
let url = ''

function docker(...args: string[]) {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })

  return { ok: result.exitCode === 0, out: result.stdout.toString().trim() }
}

function psql(target: string, sql: string): boolean {
  return Bun.spawnSync(['psql', target, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0
}

// A throwaway database on DB_TOOLS_TEST_SERVER. Returns why it could not be had, or ''.
function onServer(server: string): string {
  const target = new URL(server)

  target.pathname = `/${DATABASE}`
  url = target.href

  if (Bun.which('psql') === null)
    return 'psql is not installed'

  return psql(server, `create database ${DATABASE}`) && psql(url, SCHEMA) ? '' : `DB_TOOLS_TEST_SERVER could not take the ${DATABASE} database`
}

// A throwaway Postgres in docker on a free port. Returns why it could not be had, or ''.
async function inDocker(): Promise<string> {
  if (Bun.which('docker') === null)
    return 'docker is not installed'

  if (!docker('image', 'inspect', IMAGE).ok && !docker('pull', IMAGE).ok)
    return `docker cannot provide ${IMAGE}`

  if (!docker('run', '-d', '--rm', '--name', CONTAINER, '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-p', '127.0.0.1::5432', IMAGE).ok)
    return 'docker cannot start a container'

  let seeded = false

  for (let attempt = 0; attempt < 60 && !seeded; attempt++) {
    await Bun.sleep(500)
    // Over TCP: the image's init server answers on the socket alone, then restarts, so a socket seed can land before the real server is up.
    seeded = docker('exec', CONTAINER, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', SCHEMA).ok
  }

  const port = docker('port', CONTAINER, '5432/tcp').out.match(PORT)?.[1]

  url = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`

  return seeded ? '' : 'the throwaway Postgres never accepted the schema'
}

// Skipped with a message when neither can be had.
const reason = SERVER === undefined ? await inDocker() : onServer(SERVER)

if (reason !== '')
  console.warn(`db integration tests skipped: ${reason}`)

// Removing the container can outlast the 5 s default when the whole suite loads the machine.
afterAll(() => {
  if (SERVER !== undefined)
    psql(SERVER, `drop database if exists ${DATABASE} with (force)`)
  else if (Bun.which('docker') !== null)
    docker('rm', '-f', CONTAINER)
}, 30_000)

const cwd = temp('cli-db-')
// A home without a ~/.config/db/config.json, so the allowlist is empty unless a test writes one.
const home = temp('cli-db-home-')

async function db(args: string[], env: Record<string, string> = { DATABASE_URL: url }, stdin?: string) {
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? '', HOME: home, ...env }, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { out, err, code }
}

describe.skipIf(reason !== '')('db against Postgres', () => {
  test('runs a query, caps rows and masks sensitive columns', async () => {
    const result = await db(['select * from users order by id'])

    expect(result.code).toBe(0)
    expect(result.out).toContain('user1 ')
    expect(result.out).toContain('... more rows not shown (-n raises the cap)')
    expect(result.out).not.toContain('user101')
    expect(result.out).toContain('masked: email, password_hash')
    expect(result.out).not.toContain('u1@x.io')
  })

  test('shows masked columns with --raw, and honors -n and --json', async () => {
    const result = await db(['query', '-n', '2', '--raw', '--json', 'select id, email from users order by id'])
    const json = JSON.parse(result.out) as { rows: unknown, truncated: boolean }

    expect(json.rows).toEqual([{ id: 1, email: 'u1@x.io' }, { id: 2, email: 'u2@x.io' }])
    expect(json.truncated).toBe(true)
  })

  test('reads SQL from stdin', async () => {
    expect((await db(['query'], undefined, 'select 41 + 1 as answer')).out).toContain('42')
  })

  test.each([
    'insert into audit (note) values (\'x\')',
    'with d as (delete from audit returning *) select * from d',
    'select nextval(\'audit_id_seq\')',
    'select "nextval"(\'audit_id_seq\')',
    'select 1 --\r; delete from audit',
    'select 1; delete from audit',
  ])('prints %p instead of running it', async (sql) => {
    const result = await db([sql])

    expect(result.code).toBe(1)
    expect(result.out).toContain('```sql')
    expect(result.out).toContain(sql)
    expect((await db(['select count(*) as n from audit'])).out).toContain('0')
  })

  test('the transaction refuses a write that skips the guard, and rolls back', async () => {
    const { readRows } = await import('../src/run')

    let message = ''

    try {
      await readRows(url, 'select nextval(\'audit_id_seq\')')
    }
    catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('read-only')
    expect(await readRows(url, 'select count(*)::int as n from audit')).toEqual([{ n: 0 }])
  })

  test('reads a select through a cursor that stops one row past the cap', async () => {
    const { readRows } = await import('../src/run')

    expect(await readRows(url, 'select * from generate_series(1, 1000000) n', [], 3)).toHaveLength(4)
    expect(await readRows(url, 'select $1::int as n', [7], 3)).toEqual([{ n: 7 }])
    expect(await readRows(url, 'show server_version', [], 3)).toHaveLength(1)
    expect((await db(['-n', '0', 'select 1 as one'])).out).toContain('more rows not shown')
  })

  test('opens the session read-only with a lock and idle timeout', async () => {
    const { readRows } = await import('../src/run')
    const [settings] = await readRows(url, 'select current_setting(\'default_transaction_read_only\') as ro, current_setting(\'lock_timeout\') as lock, current_setting(\'idle_in_transaction_session_timeout\') as idle')

    expect(settings).toEqual({ ro: 'on', lock: '5s', idle: '1min' })
  })

  test('lists tables and describes one', async () => {
    const list = await db(['tables'])

    expect(list.out).toContain('users')
    expect(list.out).toContain('view')
    expect(list.out).not.toContain('pg_class')

    const columns = await db(['describe', 'public.users'])

    expect(columns.out).toContain('password_hash')
    expect(columns.out).toContain('true')
  })

  test('never prints the url or password, even in errors', async () => {
    const wrong = await db(['select * from missing_table'])
    const badPassword = await db(['select 1'], { DATABASE_URL: url.replace(PASSWORD, 'nope') })
    const noHost = await db(['select 1'], { DATABASE_URL: `postgres://postgres:${PASSWORD}@127.0.0.1:1/postgres` })

    expect(wrong.code).toBe(1)
    expect(wrong.err).toContain('missing_table')

    for (const result of [wrong, badPassword, noHost]) {
      expect(result.out + result.err).not.toContain(PASSWORD)
      expect(result.out + result.err).not.toContain('127.0.0.1:1/')
    }

    expect(badPassword.code).toBe(1)
    expect(noHost.code).toBe(1)
  })

  test('reads another key with --env, and says when it is unset', async () => {
    expect((await db(['-e', 'OTHER_URL', 'select 1 as one'], { OTHER_URL: url })).out).toContain('one')
    expect((await db(['-e', 'OTHER_URL', 'select 1'], {})).err).toContain('OTHER_URL is not set')
    expect((await db(['select 1'], {})).err).toContain('no DATABASE_URL and no running Postgres, MySQL or MariaDB service')
  })

  // A docker that answers `compose ps` and `inspect` as a project running this Postgres as its `database` service would.
  // Built only once the throwaway database exists, as its URL stays empty while the suite is skipped.
  const compose = reason !== ''
    ? { path: '', loopback: false, password: '' }
    : (() => {
      const target = new URL(url)
      const bin = temp('cli-db-docker-')
      const ps = { ID: 'abc123', Service: 'database', State: 'running', Image: 'postgres:18-alpine', Publishers: [{ URL: '0.0.0.0', TargetPort: 5432, PublishedPort: Number(target.port) }] }
      const inspect = [{ Id: 'abc123def', Name: '/app-database-1', Config: { Env: [`POSTGRES_USER=${decodeURIComponent(target.username)}`, `POSTGRES_PASSWORD=${decodeURIComponent(target.password)}`, `POSTGRES_DB=${target.pathname.slice(1)}`, 'PG_MAJOR=18'] }, NetworkSettings: { Networks: { app: { IPAddress: '10.0.0.2', Aliases: ['database', 'db'] } } } }]

      writeFileSync(join(bin, 'ps.json'), `${JSON.stringify(ps)}\n`)
      writeFileSync(join(bin, 'inspect.json'), JSON.stringify(inspect))
      writeFileSync(join(bin, 'docker'), `#!/bin/sh\ncase "$1" in compose) cat "${bin}/ps.json" ;; inspect) cat "${bin}/inspect.json" ;; *) exit 1 ;; esac\n`)
      chmodSync(join(bin, 'docker'), 0o755)

      return { path: `${bin}:${process.env.PATH ?? ''}`, loopback: target.hostname === '127.0.0.1', password: decodeURIComponent(target.password) }
    })()

  test.skipIf(!compose.loopback)('reads the compose project\'s Postgres service without a URL', async () => {
    const result = await db(['tables'], { PATH: compose.path })

    expect(result.code).toBe(0)
    expect(result.out).toContain('users')
    expect(result.out + result.err).not.toContain(compose.password)
  })

  test.skipIf(!compose.loopback)('reaches a URL naming the service as its host, Doctrine parameters dropped', async () => {
    const doctrine = new URL(url)

    doctrine.hostname = 'database'
    doctrine.port = '5432'
    doctrine.search = '?serverVersion=18&charset=utf8'

    const result = await db(['select count(*) as n from users'], { PATH: compose.path, DATABASE_URL: doctrine.href })

    expect(result.code).toBe(0)
    expect(result.out).toContain('150')
  })

  test.skipIf(!compose.loopback)('reaches a URL naming the service by a network alias', async () => {
    const aliased = new URL(url)

    aliased.hostname = 'db'

    expect((await db(['select count(*) as n from users'], { PATH: compose.path, DATABASE_URL: aliased.href })).out).toContain('150')
  })

  test('refuses a host that is neither local nor a compose service, before connecting', async () => {
    const remote = new URL(url)

    remote.hostname = 'db.example.com'

    const result = await db(['select 1'], { DATABASE_URL: remote.href })

    expect(result.code).toBe(2)
    expect(result.err).toContain('db.example.com')
    expect(result.err).toContain(join(home, '.config', 'db', 'config.json'))
    expect(result.out + result.err).not.toContain(PASSWORD)
  })

  test.skipIf(!compose.loopback)('lists the databases and reads another with --database', async () => {
    const list = await db(['dbs', '-s', 'database'], { PATH: compose.path })

    expect(list.code).toBe(0)
    expect(list.out).toContain('postgres')
    expect(list.out).toContain('true')

    const other = await db(['-s', 'database', '-d', 'postgres', 'select current_database() as current'], { PATH: compose.path })

    expect(other.out).toContain('postgres')
    expect((await db(['-s', 'nope', 'select 1'], { PATH: compose.path })).err).toContain('no running service nope')
  })
})
