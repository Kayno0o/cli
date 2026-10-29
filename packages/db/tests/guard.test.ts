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
  })
})
