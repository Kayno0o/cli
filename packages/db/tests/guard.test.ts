import { describe, expect, test } from 'bun:test'
import { inspect, writes } from '../src/guard'

const reads = [
  'select * from users',
  'SELECT 1;',
  'with x as (select 1) select * from x',
  'select \'delete from users\' as note',
  'select "update" from t -- insert into t',
  'select /* drop table t */ 1',
  'select $$ delete from t $$',
  'select $tag$ insert into x $tag$',
  'select E\'it\\\'s; delete from t\'',
  'select case when a then 1 else 2 end from t',
  'select comment, "set" from t',
  'explain select * from t',
  'explain (analyze, buffers) select * from t',
  'show server_version',
  'table users',
  'values (1), (2)',
  'select "set", "drop", "a""b", `drop` from t',
  'select 1 --\r, 2',
  'select "Pg_Sleep" from t',
]

const writing: [string, string][] = [
  ['insert into t values (1)', 'starts with insert'],
  ['delete from t', 'starts with delete'],
  ['update t set a = 1', 'UPDATE'],
  ['drop table t', 'starts with drop'],
  ['with x as (delete from t returning *) select * from x', 'DELETE'],
  ['with x as (update t set a = 1 returning *) select * from x', 'UPDATE'],
  ['with x as (insert into t values (1) returning *) select * from x', 'INSERT'],
  ['select * into copy from t', 'INTO'],
  ['select nextval(\'seq\')', 'nextval'],
  ['select pg_catalog.setval(\'seq\', 1)', 'setval'],
  ['select pg_terminate_backend(1)', 'pg_terminate_backend'],
  ['select set_config(\'transaction_read_only\', \'off\', true)', 'set_config'],
  ['select * from t for update', 'row locks'],
  ['select 1; delete from t', 'starts with delete'],
  ['select 1; /* hi */ drop table t;', 'starts with drop'],
  ['set transaction read write', 'starts with set'],
  ['commit', 'starts with commit'],
  ['explain analyze delete from t', 'DELETE'],
  ['analyze t', 'starts with analyze'],
  ['select lo_unlink(1)', 'lo_unlink'],
  ['call do_things()', 'starts with call'],
  ['select 1 --\r; delete from t', 'starts with delete'],
  ['select 1 --\r; select pg_terminate_backend(1)', 'pg_terminate_backend'],
  ['select 1 \0', 'NUL'],
  ['select "pg_terminate_backend"(1)', 'calls pg_terminate_backend'],
  ['select pg_catalog."pg_terminate_backend"(1)', 'calls pg_terminate_backend'],
  ['select "nextval"(\'s\')', 'calls nextval'],
  ['select "a""b", "setval"(\'s\', 1)', 'calls setval'],
  ['select U&"\\0070g_sleep"(10)', 'U& escaped identifier'],
  ['select `pg_sleep`(1)', 'calls pg_sleep'],
  ['select pg_sleep(10)', 'calls pg_sleep'],
  ['select pg_sleep_for(\'1 day\')', 'calls pg_sleep_for'],
  ['select pg_stat_file(\'/etc/passwd\')', 'calls pg_stat_file'],
  ['select * from pg_ls_waldir()', 'calls pg_ls_waldir'],
  ['select * from pg_ls_logdir()', 'calls pg_ls_logdir'],
  ['select pg_export_snapshot()', 'calls pg_export_snapshot'],
  ['select pg_backup_start(\'x\')', 'calls pg_backup_start'],
  ['select txid_current()', 'calls txid_current'],
  ['select table_to_xml(\'t\', true, false, \'\')', 'calls table_to_xml'],
  ['select cursor_to_xml(\'c\', 1, true, false, \'\')', 'calls cursor_to_xml'],
  ['select pg_wal_replay_pause()', 'calls pg_wal_replay_pause'],
  ['select pg_current_logfile()', 'calls pg_current_logfile'],
]

describe('inspect', () => {
  test.each(reads)('lets %p through', (sql) => {
    expect(inspect(sql).reasons).toEqual([])
  })

  test.each(writing)('stops %p', (sql, reason) => {
    expect(inspect(sql).reasons.join(' ')).toContain(reason)
  })

  test('counts statements and ignores empty ones', () => {
    expect(inspect('select 1; select 2;;').statements).toBe(2)
  })
})

describe('writes', () => {
  test('passes what only reads, however it starts', () => {
    for (const sql of ['\\dt', 'describe users', 'show tables', 'select * from t where note = \'drop it\'', 'select * from "grant"', '-- delete from t\nselect 1'])
      expect(writes(sql)).toEqual([])
  })

  test('names what writes, locks or has a side effect, wherever it sits', () => {
    expect(writes('with d as (delete from t returning *) select * from d')).toEqual(['uses DELETE'])
    expect(writes('select 1; truncate logs')).toEqual(['uses TRUNCATE'])
    expect(writes('select nextval(\'s\')')).toEqual(['calls nextval'])
    expect(writes('\\copy t from \'x.csv\'')).toEqual(['uses COPY'])
    expect(writes('comment on table t is \'x\'')).toEqual(['uses COMMENT ON'])
    expect(writes('select comment from posts')).toEqual([])
  })

  test('sees inside what would hide a write: a DO body, a MySQL /*! comment, a quote that never closes', () => {
    expect(writes('do $$ begin delete from t; end $$')).toEqual(['uses DO'])
    expect(writes('select 1 /*!50000 ; drop table t */')).toEqual(['uses DROP'])
    expect(writes('select \'a; drop table t')).toEqual(['has a quote that never closes'])
    expect(writes('select $x$ never closed')).toEqual(['has a quote that never closes'])
  })

  test('lets session settings, exports and names that look like keywords read', () => {
    for (const sql of ['set search_path to app', 'set statement_timeout = 5000', '\\set x 1', 'copy (select 1) to stdout', '\\copy t to \'x.csv\'', 'select u.lock, u.call from u'])
      expect(writes(sql)).toEqual([])

    expect(writes('set role admin')).toEqual(['uses SET'])
    expect(writes('set transaction read write')).toEqual(['uses SET'])
    expect(writes('select 1; set session authorization x')).toEqual(['uses SET'])
    expect(writes('copy t to \'/tmp/x.csv\'')).toEqual(['uses COPY'])
    expect(writes('copy t from stdin')).toEqual(['uses COPY'])
  })
})
