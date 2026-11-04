import { parse } from '@kaynooo/cli-kit'
import { describe, expect, test } from 'bun:test'
import { catalogOptions, outputOptions, rowLimit } from '../src/args'
import { explainSql } from '../src/commands/explain'
import { containing, describePlans } from '../src/commands/schema'

describe('explainSql', () => {
  test('prefixes a plain read with EXPLAIN alone', () => {
    expect(explainSql('select * from users;', 'postgres')).toBe('EXPLAIN select * from users')
    expect(explainSql('  with a as (select 1) select * from a', 'mysql')).toBe('EXPLAIN with a as (select 1) select * from a')
  })

  test.each([
    'analyze select 1',
    'explain analyze select 1',
    'explain select 1',
    'show server_version',
    'select 1; select 2',
    'select nextval(\'s\')',
    'with d as (delete from t returning *) select * from d',
    'delete from users',
  ])('refuses %p, ANALYZE above all', (sql) => {
    expect(() => explainSql(sql, 'postgres')).toThrow()
  })
})

describe('the row cap', () => {
  test('is 20, --all brings back the old 100 and -n wins otherwise', () => {
    expect(rowLimit({})).toBe(20)
    expect(rowLimit({ all: true })).toBe(100)
    expect(rowLimit({ rows: '7' })).toBe(7)
    expect(rowLimit({}, 5)).toBe(5)
  })

  test('--all and -n together are a usage error', () => {
    expect(() => parse(['--all', '-n', '5'], 'x', outputOptions)).toThrow()
    expect(parse(['--all'], 'x', catalogOptions).values.all).toBe(true)
  })
})

describe('search and describe', () => {
  test('a search text takes its % and _ literally', () => {
    expect(containing('user_id')).toBe('%user\\_id%')
    expect(containing('100%')).toBe('%100\\%%')
  })

  test('describe asks for columns, indexes and foreign keys, scoped alike', () => {
    const bare = describePlans('users', undefined)
    const scoped = describePlans('users', 'shop')

    expect(bare.indexes.postgres.sql).toContain('pg_index')
    expect(bare.foreignKeys.postgres.sql).toContain('pg_get_constraintdef')
    expect(bare.indexes.postgres.params).toEqual(['users', null])
    expect(scoped.foreignKeys.postgres.params).toEqual(['users', 'shop'])
    expect(scoped.indexes.mysql.params).toEqual(['users', 'shop'])
    expect(bare.foreignKeys.mysql.sql).toContain('coalesce(database()')
  })
})
