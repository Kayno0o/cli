import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '@kaynooo/cli-kit/test'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const temp = tempDirs()

function dbCli(args: string[], cwd: string) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

function seedSqlite(path: string, extraColumn = false): void {
  const db = new Database(path)

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      commit_hash TEXT,
      created_at TEXT NOT NULL
      ${extraColumn ? ', bio TEXT' : ''}
    );
    CREATE INDEX idx_users_email ON users(email);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      total INTEGER NOT NULL
    );
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY
    );
    INSERT INTO users (id, email, password_hash, commit_hash, created_at) VALUES
      (1, 'alice@example.com', 'hash1', 'abc123', '2026-01-01'),
      (2, 'bob@example.com', 'hash2', 'def456', '2026-01-02');
    INSERT INTO orders (id, user_id, total) VALUES (10, 1, 500);
    INSERT INTO schema_migrations (version) VALUES ('20260101_init');
  `)
  db.close()
}

describe('db with SQLite and inspection commands', () => {
  test('supports direct SQLite queries, masking fixes, --unmask, --env-file, and read-only safety', () => {
    const dir = temp('db-sqlite-')
    const appDb = join(dir, 'app.db')
    const testDb = join(dir, 'app_test.db')

    seedSqlite(appDb)
    seedSqlite(testDb)
    writeFileSync(join(dir, '.env.local'), `DATABASE_URL=sqlite://${appDb}\n`)

    const direct = dbCli([appDb, 'select id, email, password_hash, commit_hash from users order by id', '--json'], dir)

    expect(direct.code).toBe(0)
    expect(JSON.parse(direct.out)).toMatchObject({
      rows: [
        { id: 1, email: '***', password_hash: '***', commit_hash: 'abc123' },
        { id: 2, email: '***', password_hash: '***', commit_hash: 'def456' },
      ],
      masked: ['email', 'password_hash'],
    })

    const unmasked = dbCli([appDb, 'select email, password_hash from users where id = 1', '--unmask', 'email', '--json'], dir)

    expect(unmasked.code).toBe(0)
    expect(JSON.parse(unmasked.out)).toMatchObject({
      rows: [{ email: 'alice@example.com', password_hash: '***' }],
      masked: ['password_hash'],
    })

    const viaEnv = dbCli(['--env-file', join(dir, '.env.local'), 'select count(*) as n from users', '--json'], dir)

    expect(viaEnv.code).toBe(0)
    expect(JSON.parse(viaEnv.out)).toMatchObject({ rows: [{ n: 2 }] })

    // Writes are refused on app.db, allowed on app_test.db.
    expect(dbCli([appDb, 'delete from orders'], dir).code).toBe(1)
    expect(dbCli([testDb, 'delete from orders'], dir).code).toBe(0)
  })

  test('supports schema, ddl, describe, tables, search, sample --latest/--order, sizes, migrations, explain, and diff', () => {
    const dir = temp('db-inspect-')
    const leftDb = join(dir, 'left.sqlite')
    const rightDb = join(dir, 'right.sqlite')

    seedSqlite(leftDb, false)
    seedSqlite(rightDb, true)

    const schemaRes = dbCli(['schema', '-f', leftDb, '--json'], dir)

    expect(schemaRes.code).toBe(0)
    expect((JSON.parse(schemaRes.out) as { tables: { name: string }[] }).tables.map(t => t.name)).toEqual(['orders', 'schema_migrations', 'users'])

    const ddlRes = dbCli(['ddl', 'users', '-f', leftDb], dir)

    expect(ddlRes.code).toBe(0)
    expect(ddlRes.out).toContain('CREATE TABLE users')
    expect(ddlRes.out).toContain('CREATE INDEX idx_users_email')

    const descRes = dbCli(['describe', 'orders', '-f', leftDb, '--json'], dir)

    expect(descRes.code).toBe(0)
    expect(JSON.parse(descRes.out)).toMatchObject({
      foreignKeys: [expect.objectContaining({ column: 'user_id', references_table: 'users' })],
    })

    const latestRes = dbCli(['sample', 'users', '-f', leftDb, '--latest', '-n', '1', '--json'], dir)

    expect(latestRes.code).toBe(0)
    expect(JSON.parse(latestRes.out)).toMatchObject({ rows: [expect.objectContaining({ id: 2 })] })

    const sizesRes = dbCli(['sizes', '-f', leftDb, '--json'], dir)

    expect(sizesRes.code).toBe(0)
    expect((JSON.parse(sizesRes.out) as { rows: { table: string, rows: number }[] }).rows[0]).toMatchObject({ table: 'users', rows: 2 })

    const migRes = dbCli(['migrations', '-f', leftDb, '--json'], dir)

    expect(migRes.code).toBe(0)
    expect(JSON.parse(migRes.out)).toMatchObject({ table: 'schema_migrations', rows: [{ version: '20260101_init' }] })

    const explainRes = dbCli(['explain', '-f', leftDb, 'select * from users where email = \'a\''], dir)

    expect(explainRes.code).toBe(0)
    expect(explainRes.out).toContain('idx_users_email')

    const diffRes = dbCli(['diff', leftDb, rightDb, '--json'], dir)

    expect(diffRes.code).toBe(1)
    expect(JSON.parse(diffRes.out)).toEqual({
      addedTables: [],
      removedTables: [],
      changedTables: [{ table: 'users', addedColumns: ['bio'], removedColumns: [], changedColumns: [] }],
    })

    expect(dbCli(['diff', leftDb, leftDb], dir).code).toBe(0)
  })
})
