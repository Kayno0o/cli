import type { Result } from '../src/run'
import { Exit } from '@kaynooo/cli-kit'
import { describe, expect, test } from 'bun:test'
import { sqlViolation } from '../src/clients'
import { testWriteBlockers } from '../src/guard'
import { allowsKeyRetrieval, connectionUrl, databaseOfUrl, dialectOf, mysqlTransaction, readRows, writeRows } from '../src/run'

const PASSWORD = 'never-printed-pw-4417'
const MYSQL_URL = `mysql://app:${PASSWORD}@127.0.0.1:3306/app_test`
const POSTGRES_URL = `postgres://app:${PASSWORD}@127.0.0.1:5432/app_test`

interface Stub {
  calls: string[]
  connect: (url: string, dialect: 'postgres' | 'mysql', readOnly: boolean) => { transaction: (work: (tx: { unsafe: (statement: string, params?: unknown[]) => Promise<Result> }) => Promise<void>, readOnly: boolean) => Promise<void>, close: () => Promise<void> }
}

// A SQL runner that answers for the server: which database the session is on, what a failing statement says, and what rows come back. Nothing connects anywhere.
function stub(options: { actual?: string, failing?: RegExp, failure?: Error, rows?: Record<string, unknown>[] } = {}): Stub {
  const calls: string[] = []
  const connect: Stub['connect'] = (_url, _dialect, readOnly) => {
    calls.push(`connect ${readOnly ? 'read-only' : 'read-write'}`)

    return {
      async transaction(work, isReadOnly) {
        calls.push(`begin ${isReadOnly ? 'read-only' : 'read-write'}`)

        try {
          await work({
            async unsafe(statement) {
              calls.push(statement)

              if (options.failing?.test(statement) === true)
                throw options.failure ?? new Error(`syntax error near ${PASSWORD}`)

              if ((/current_database\(\)|select database\(\)/).test(statement))
                return Object.assign([{ name: options.actual ?? 'app_test' }], { affected: 1 })

              return Object.assign([...options.rows ?? []], { affected: 3 })
            },
          })
          calls.push('commit')
        }
        catch (error) {
          calls.push('rollback')

          throw error
        }
      },
      async close() {
        calls.push('close')
      },
    }
  }

  return { calls, connect }
}

async function exitMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  }
  catch (error) {
    if (error instanceof Exit)
      return error.message
  }

  return ''
}

describe('dialectOf', () => {
  test('tells the engines by scheme and refuses the rest', () => {
    expect(dialectOf(new URL('postgresql://u@h/d'))).toBe('postgres')
    expect(dialectOf(new URL('mysql://u@h/d'))).toBe('mysql')
    expect(dialectOf(new URL('mariadb://u@h/d'))).toBe('mysql')
    expect(() => dialectOf(new URL('sqlite:///tmp/x.db'))).toThrow('Postgres')
  })
})

describe('connectionUrl', () => {
  test('refuses --service and --container together', async () => {
    expect(await exitMessage(async () => connectionUrl({ service: 'db', container: 'other' }))).toContain('pick one')
  })

  test('reads a MySQL URL from the environment, Doctrine parameters dropped', async () => {
    Bun.env.DB_TOOLS_TEST_MYSQL = 'mysql://app:pw@127.0.0.1:3306/app?serverVersion=8.0&charset=utf8mb4'

    expect(await connectionUrl({ env: 'DB_TOOLS_TEST_MYSQL' })).toBe('mysql://app:pw@127.0.0.1:3306/app')
  })
})

describe('readRows on MySQL', () => {
  test('reads in a read-only transaction that is rolled back, a select wrapped to stop one row past the limit', async () => {
    const { calls, connect } = stub({ rows: [{ id: 1 }] })

    expect(await readRows(MYSQL_URL, 'select id from users;', [], 5, connect)).toEqual([{ id: 1 }])
    expect(calls).toEqual(['connect read-only', 'begin read-only', 'select * from (\nselect id from users\n) as db_rows limit 6', 'rollback', 'close'])
  })

  test('reads a statement the wrapping does not fit whole', async () => {
    const { calls, connect } = stub({ failing: /db_rows/, failure: Object.assign(new Error('Duplicate column name \'id\''), { errno: 1060 }), rows: [{ id: 1 }] })

    expect(await readRows(MYSQL_URL, 'select id, id from users', [], 5, connect)).toEqual([{ id: 1 }])
    expect(calls.filter(call => call.startsWith('select'))).toEqual(['select * from (\nselect id, id from users\n) as db_rows limit 6', 'select id, id from users'])
  })

  test('rethrows an error the wrapping did not cause instead of running the statement again', async () => {
    const { calls, connect } = stub({ failing: /db_rows/, failure: Object.assign(new Error('Query execution was interrupted'), { errno: 3024 }) })

    expect(await exitMessage(async () => readRows(MYSQL_URL, 'select name from users', [], 5, connect))).toContain('interrupted')
    expect(calls.filter(call => call.startsWith('select'))).toHaveLength(1)
  })

  test('scrubs the password from the error of the database', async () => {
    const { connect } = stub({ failing: /boom/ })
    const message = await exitMessage(async () => readRows(MYSQL_URL, 'show boom', [], 5, connect))

    expect(message).toContain('syntax error')
    expect(message).not.toContain(PASSWORD)
  })
})

describe('mysqlTransaction', () => {
  function connection(failing?: RegExp) {
    const calls: string[] = []

    return {
      calls,
      unsafe: async (statement: string) => {
        calls.push(statement)

        if (failing?.test(statement) === true)
          throw new Error('lost connection')

        return []
      },
    }
  }

  test('starts a read-only transaction on the connection that runs the statement, rolled back when the work throws', async () => {
    const conn = connection()

    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(mysqlTransaction(conn, async (tx) => {
      await tx.unsafe('select 1')

      throw new Error('stop')
    }, true)).rejects.toThrow('stop')
    expect(conn.calls.filter(call => !call.startsWith('SET SESSION max_'))).toEqual(['START TRANSACTION READ ONLY', 'select 1', 'ROLLBACK'])
  })

  test('commits a write', async () => {
    const conn = connection()

    await mysqlTransaction(conn, async (tx) => {
      await tx.unsafe('update t set a = 1')
    }, false)
    expect(conn.calls.filter(call => !call.startsWith('SET SESSION max_'))).toEqual(['START TRANSACTION', 'update t set a = 1', 'COMMIT'])
  })

  test('keeps the error of the work when the rollback fails too', async () => {
    const conn = connection(/ROLLBACK/)

    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(mysqlTransaction(conn, async () => {
      throw new Error('stop')
    }, true)).rejects.toThrow('stop')
  })
})

describe('writeRows', () => {
  test('runs a write on a database ending in _test and commits it, after asking the server which database it is on', async () => {
    const { calls, connect } = stub()
    const result = await writeRows(MYSQL_URL, 'insert into users (name) values (\'a\')', connect)

    expect(result).toEqual({ isRun: true, database: 'app_test', rows: [], affected: 3 })
    expect(calls).toEqual(['connect read-write', 'begin read-write', 'select database() as name', 'insert into users (name) values (\'a\')', 'commit', 'close'])
  })

  test('runs on Postgres too, asking current_database()', async () => {
    const { calls, connect } = stub()

    expect(await writeRows(POSTGRES_URL, 'delete from users', connect)).toMatchObject({ isRun: true, database: 'app_test' })
    expect(calls).toContain('select current_database() as name')
  })

  test('hands back any other database without connecting', async () => {
    for (const url of ['mysql://app:pw@h/app', 'mysql://app:pw@h/test_app', 'mysql://app:pw@h/app_TEST', 'mysql://app:pw@h/', 'postgres://app:pw@h/app_test_old']) {
      const { calls, connect } = stub()
      const result = await writeRows(url, 'delete from users', connect)

      expect(result.isRun).toBe(false)
      expect(calls).toEqual([])
    }
  })

  test('trusts the server over the URL: a session on another database is rolled back before the statement', async () => {
    const { calls, connect } = stub({ actual: 'app' })
    const result = await writeRows(MYSQL_URL, 'delete from users', connect)

    expect(result.isRun).toBe(false)
    expect(calls).toEqual(['connect read-write', 'begin read-write', 'select database() as name', 'rollback', 'close'])
  })

  test('rolls back and scrubs when the statement fails', async () => {
    const { calls, connect } = stub({ failing: /^delete/ })
    const message = await exitMessage(async () => writeRows(MYSQL_URL, 'delete from users', connect))

    expect(message).not.toContain(PASSWORD)
    expect(calls).toContain('rollback')
    expect(calls).not.toContain('commit')
  })

  test('names the database of a URL', () => {
    expect(databaseOfUrl(MYSQL_URL)).toBe('app_test')
    expect(databaseOfUrl('mysql://u:p@h/')).toBe('')
    expect(databaseOfUrl('mysql://u:p@h/my%20db_test')).toBe('my db_test')
  })
})

// None of these may run, on any database, even one ending in _test: each reaches past it.
const MYSQL_ESCAPES: [string, string][] = [
  ['use prod', 'starts with use'],
  ['USE `prod`', 'starts with use'],
  ['/*! use prod */', 'starts with use'],
  ['/*!50000 USE prod */', 'starts with use'],
  ['/*M!100100 use prod */', 'starts with use'],
  ['update t set a = 1; use prod', 'several statements'],
  ['update t set a = 1 # hidden\n; use prod', 'several statements'],
  ['update t set a = 1 /* a /* b */ ; use prod /* c */', 'several statements'],
  ['update t set a = 1;use prod', 'several statements'],
  ['update prod.users set a = 1', 'names the database prod'],
  ['update `prod`.users set a = 1', 'names the database prod'],
  ['update prod . users set a = 1', 'names the database prod'],
  ['update app_test.users u join prod.users p on p.id = u.id set u.a = 1', 'names the database prod'],
  ['delete from users where id in (select id from prod.users)', 'names the database prod'],
  ['insert into t select * from other.t', 'names the database other'],
  ['create table t like other.t', 'names the database other'],
  ['alter table t rename to other.t', 'names the database other'],
  ['rename table t to other.t', 'names the database other'],
  ['select * from information_schema.tables', 'names the database information_schema'],
  ['update t set a = (select count(*) from prod.5t)', 'names the database prod'],
  ['insert into prod_é.t values (1)', 'names the database prod_é'],
  ['drop table 日本.t', 'names the database 日本'],
  ['drop database prod', 'defines a database'],
  ['drop schema prod', 'defines a schema'],
  ['create database other', 'defines a database'],
  ['create user x identified by \'y\'', 'defines a user'],
  ['alter user root identified by \'y\'', 'defines a user'],
  ['set global read_only = 0', 'starts with set'],
  ['set @@global.read_only = 0', 'starts with set'],
  ['load data infile \'/etc/passwd\' into table t', 'starts with load'],
  ['select * from t into outfile \'/tmp/x\'', 'uses outfile'],
  ['select load_file(\'/etc/passwd\')', 'uses load_file'],
  ['select sleep(100)', 'uses sleep'],
  ['prepare s from \'drop database prod\'', 'starts with prepare'],
  ['call p()', 'starts with call'],
  ['grant all on *.* to x', 'starts with grant'],
  ['create table t (a int) engine=federated connection=\'mysql://u:p@h/db/t\'', 'uses federated'],
  ['update t set a = 1 -- \n; use prod', 'several statements'],
  ['update t set a = 1 --\tx\n; use prod', 'several statements'],
  ['update t set a = \'x\\\' ; use prod', 'quote that never closes'],
  ['rename user a to b', 'defines a user'],
  ['create event e on schedule at current_timestamp do drop database prod', 'defines a event'],
  ['create procedure p() drop database prod', 'defines a procedure'],
  ['create definer = root@localhost trigger t before insert on x for each row set new.a = 1', 'defines a definer'],
  ['alter event e do drop database prod', 'defines a event'],
]

const POSTGRES_ESCAPES: [string, string][] = [
  ['\\c prod', 'starts with'],
  ['create or replace function f() returns void as $$ begin perform pg_terminate_backend(1); end $$ language plpgsql', 'defines a function'],
  ['delete from t; \\c prod', 'several statements'],
  ['do $$ begin perform dblink_exec(\'x\', \'drop table t\'); end $$', 'starts with do'],
  ['select dblink_exec(\'dbname=prod\', \'delete from t\')', 'uses dblink_exec'],
  ['copy t to program \'rm -rf /\'', 'starts with copy'],
  ['select pg_terminate_backend(1)', 'uses pg_terminate_backend'],
  ['select pg_read_file(\'/etc/passwd\')', 'uses pg_read_file'],
  ['drop database prod', 'defines a database'],
  ['create role x', 'defines a role'],
  ['create or replace server s foreign data wrapper w', 'defines a server'],
  ['alter system set fsync = off', 'defines a system'],
  ['set role admin', 'starts with set'],
  ['delete from t where a = \'x', 'quote that never closes'],
  ['select U&"\\0064blink_exec"(1)', 'escaped identifier'],
]

describe('testWriteBlockers, the escapes from a _test database', () => {
  test.each(MYSQL_ESCAPES)('MySQL refuses %p', (sql, reason) => {
    expect(testWriteBlockers(sql, 'mysql', 'app_test').join(' ')).toContain(reason)
  })

  test.each(POSTGRES_ESCAPES)('Postgres refuses %p', (sql, reason) => {
    expect(testWriteBlockers(sql, 'postgres', 'app_test').join(' ')).toContain(reason)
  })

  test('an escape is never run, whatever database the session is on', async () => {
    for (const [sql] of MYSQL_ESCAPES) {
      const { calls, connect } = stub()

      expect((await writeRows(MYSQL_URL, sql, connect)).isRun).toBe(false)
      expect(calls.filter(call => call === sql)).toEqual([])
    }
  })

  test('lets plain writes on the database itself through', () => {
    for (const sql of ['insert into users (name) values (\'a\') on duplicate key update name = \'b\'', 'replace into users values (1)', 'update users set role = \'x\' where id = 1', 'update app_test.users set a = 1', 'update `APP_TEST`.users set a = 1', 'delete from users', 'truncate users', 'create table x (id int, role text, `database` int)', 'alter table users add column user int', 'drop table if exists x', 'rename table a to b', 'drop procedure if exists p', 'insert into users select * from users;', 'update t set a = \'x\\\' ; use prod\'', 'with x as (select 1) delete from t'])
      expect(testWriteBlockers(sql, 'mysql', 'app_test')).toEqual([])

    for (const sql of ['insert into t values (1) on conflict do nothing', 'select nextval(\'s\')', 'update public.t set a = 1', 'create table t (role text)', 'drop schema if exists x cascade'])
      expect(testWriteBlockers(sql, 'postgres', 'app_test')).toEqual([])
  })

  test('a system variable is no database', () => {
    expect(testWriteBlockers('update t set a = (select @@global.max_connections)', 'mysql', 'app_test')).toEqual([])
    expect(testWriteBlockers('update t set a = (select @@session.sql_mode)', 'mysql', 'app_test')).toEqual([])
  })

  test('keeps the qualifier check on the connected database, not on the name in the URL', () => {
    expect(testWriteBlockers('update other_test.t set a = 1', 'mysql', 'app_test').join(' ')).toContain('names the database other_test')
    expect(testWriteBlockers('update other_test.t set a = 1', 'mysql', 'other_test')).toEqual([])
  })
})

describe('the MySQL forms of a write', () => {
  async function violation(command: string): Promise<string | null> {
    return sqlViolation(command, async () => null)
  }

  test('a client given them is stopped', async () => {
    for (const statement of ['REPLACE INTO t VALUES (1)', 'LOAD DATA INFILE \'/x\' INTO TABLE t', 'SET GLOBAL max_connections = 1', 'insert into t values (1) on duplicate key update a = 1', 'select 1; delete from t', '/*! DELETE FROM t */', 'PREPARE s FROM \'DELETE FROM t\'', 'select 1--1; delete from t'])
      expect(await violation(`mysql -e "${statement}"`)).not.toBeNull()
  })

  test('and reading still passes', async () => {
    for (const statement of ['select replace(name, \'a\', \'b\') from t', 'show tables', 'describe users'])
      expect(await violation(`mysql -e "${statement}"`)).toBeNull()
  })
})

describe('a write on a client the abbreviations and test-looking words must not let through', () => {
  const refused = async (command: string) => sqlViolation(command, async () => null)

  test('refuses an abbreviated --command or --execute', async () => {
    expect(await refused('psql -h prod --comm "DELETE FROM users"')).not.toBeNull()
    expect(await refused('psql -h prod --command "DELETE FROM users"')).not.toBeNull()
    expect(await refused('mysql -h prod --exec "DELETE FROM users"')).not.toBeNull()
    expect(await refused('mysql -h prod --exec="DELETE FROM users"')).not.toBeNull()
  })

  test('refuses a write when only an unrelated variable before the client says test', async () => {
    expect(await refused('PGUSER=test_user psql -h prod -c "DELETE FROM users"')).not.toBeNull()
    expect(await refused('PGPASSWORD=test psql -h prod -c "DELETE FROM users"')).not.toBeNull()
    expect(await refused('USERNAME=test psql -h prod -c "DELETE FROM users"')).not.toBeNull()
    expect(await refused('HOSTNAME=test-box psql -h prod -c "DELETE FROM users"')).not.toBeNull()
    expect(await refused('docker exec -u test_user db psql -h prod -c "DELETE FROM users"')).not.toBeNull()
    expect(await refused('sudo -u test psql -h prod -c "DELETE FROM users"')).not.toBeNull()
    expect(await refused('sudo --user=test psql -h prod -c "DELETE FROM users"')).not.toBeNull()
  })

  test('still lets a test-scoped target through', async () => {
    expect(await refused('APP_ENV=test psql -c "DELETE FROM users"')).toBeNull()
    expect(await refused('PGDATABASE=app_test psql -c "DELETE FROM users"')).toBeNull()
    expect(await refused('DB_NAME=app_test psql -c "DELETE FROM users"')).toBeNull()
    expect(await refused('psql -d app_test -c "DELETE FROM users"')).toBeNull()
  })
})

describe('a file a client is fed and cannot be read', () => {
  const refused = async (command: string) => sqlViolation(command, async () => null)

  test('is named with the reason and the way out', async () => {
    expect(await refused('psql -U postgres < /work/fixture.sql')).toContain('/work/fixture.sql, which cannot be read here (missing when the command is checked')
    expect(await refused('psql -f $S/fixture.sql')).toContain('its path holds a variable or substitution')
    expect(await refused('psql -f /dev/zero')).toContain('(a device)')
    expect(await refused('psql -f /work/fixture.sql')).toContain('file edit tool')
  })
})

describe('allowsKeyRetrieval, MySQL 8 logging in without TLS', () => {
  test('fetches the server key on this machine and its docker networks only', () => {
    for (const url of ['mysql://app:pw@127.0.0.1:43306/app_test', 'mysql://app:pw@localhost/app', 'mysql://app:pw@[::1]:3306/app', 'mysql://app:pw@172.18.0.3:3306/app', 'mysql://app:pw@172.31.255.1/app'])
      expect(allowsKeyRetrieval(url)).toBe(true)

    for (const url of ['mysql://app:pw@db.example.com/app', 'mysql://app:pw@192.168.1.20/app', 'mysql://app:pw@172.32.0.1/app', 'mysql://app:pw@10.0.0.5/app', 'mysql://app:pw@172.20.evil.com/app', 'mysql://app:pw@172.20.1.1.evil.com/app', 'not a url'])
      expect(allowsKeyRetrieval(url)).toBe(false)
  })
})

describe('the statement timeout', () => {
  test('mysqlTransaction sets both settings from the given milliseconds', async () => {
    const calls: string[] = []

    await mysqlTransaction({ unsafe: async (statement) => {
      calls.push(statement)

      return []
    } }, async () => Promise.resolve(), true, 2500)
    expect(calls.slice(0, 2)).toEqual(['SET SESSION max_execution_time = 2500', 'SET SESSION max_statement_time = 2.5'])
  })

  test('readRows hands the timeout to the connection', async () => {
    const seen: (number | undefined)[] = []
    const { connect } = stub()

    await readRows(POSTGRES_URL, 'select 1', [], undefined, (url, dialect, readOnly, timeoutMs) => {
      seen.push(timeoutMs)

      return connect(url, dialect, readOnly)
    }, 1500)
    expect(seen).toEqual([1500])
  })
})
