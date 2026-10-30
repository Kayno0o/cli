import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, test } from 'bun:test'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const IMAGE = 'postgres:18-alpine'
// A Postgres the suite may create and drop its own database in, as CI starts the runner image's: set only there, so the tests never touch an existing database.
const SERVER = process.env.DB_TOOLS_TEST_SERVER
const PASSWORD = SERVER === undefined ? 'pw-never-printed-9731' : decodeURIComponent(new URL(SERVER).password)
const CONTAINER = `db-tools-test-${process.pid}`
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

afterAll(() => {
  if (SERVER !== undefined)
    psql(SERVER, `drop database if exists ${DATABASE} with (force)`)
  else if (Bun.which('docker') !== null)
    docker('rm', '-f', CONTAINER)
})

const cwd = mkdtempSync(join(tmpdir(), 'db-tools-'))

async function db(args: string[], env: Record<string, string> = { DATABASE_URL: url }, stdin?: string) {
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? '', ...env }, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { out, err, code }
}

describe.skipIf(reason !== '')('db against Postgres', () => {
  test('runs a query, caps rows and masks sensitive columns', async () => {
    const result = await db(['select * from users order by id'])

    expect(result.code).toBe(0)
    expect(result.out).toContain('user1 ')
    expect(result.out).toContain('50 more rows not shown (150 in all')
    expect(result.out).toContain('masked: email, password_hash')
    expect(result.out).not.toContain('u1@x.io')
  })

  test('shows masked columns with --raw, and honors -n and --json', async () => {
    const result = await db(['query', '-n', '2', '--raw', '--json', 'select id, email from users order by id'])
    const json = JSON.parse(result.out) as { rows: unknown, omitted: number }

    expect(json.rows).toEqual([{ id: 1, email: 'u1@x.io' }, { id: 2, email: 'u2@x.io' }])
    expect(json.omitted).toBe(148)
  })

  test('reads SQL from stdin', async () => {
    expect((await db(['query'], undefined, 'select 41 + 1 as answer')).out).toContain('42')
  })

  test.each([
    'insert into audit (note) values (\'x\')',
    'with d as (delete from audit returning *) select * from d',
    'select nextval(\'audit_id_seq\')',
    'select 1; delete from audit',
  ])('prints %p instead of running it', async (sql) => {
    const result = await db([sql])

    expect(result.code).toBe(3)
    expect(result.out).toContain('```sql')
    expect(result.out).toContain(sql)
    expect((await db(['select count(*) as n from audit'])).out).toContain('0')
  })

  test('the transaction refuses a write that skips the guard, and rolls back', async () => {
    const { readRows } = await import('../src/run')

    let message = ''

    try {
      await readRows(url, 'insert into audit (note) values (\'x\')')
    }
    catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('read-only')
    expect(await readRows(url, 'select count(*)::int as n from audit')).toEqual([{ n: 0 }])
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
    expect((await db(['select 1'], {})).err).toContain('DATABASE_URL is not set')
  })
})
