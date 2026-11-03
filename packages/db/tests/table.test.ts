import { describe, expect, test } from 'bun:test'
import { countSql, quotedTable, sampleSql } from '../src/commands/table'
import { inspect } from '../src/guard'

describe('quotedTable', () => {
  test('quotes a name or schema.name for the engine', () => {
    expect(quotedTable('users', 'postgres')).toBe('"users"')
    expect(quotedTable('public.users', 'postgres')).toBe('"public"."users"')
    expect(quotedTable('shop.order_items', 'mysql')).toBe('`shop`.`order_items`')
  })

  test.each(['users; drop table users', 'a.b.c', 'a b', '"users"', 'users--', '', '1users'])('refuses %p', (target) => {
    expect(() => quotedTable(target, 'postgres')).toThrow()
  })
})

describe('the statements', () => {
  test('sample and count read one table, with an optional condition', () => {
    expect(sampleSql('users', 'postgres', 5, undefined)).toBe('select * from "users" limit 5')
    expect(sampleSql('users', 'mysql', 2, 'id > 3')).toBe('select * from `users` where id > 3 limit 2')
    expect(countSql('users', 'postgres', undefined)).toBe('select count(*) as count from "users"')
    expect(countSql('users', 'postgres', 'active')).toBe('select count(*) as count from "users" where active')
  })

  test('are reads for the guard, a condition smuggling a write is not', () => {
    expect(inspect(sampleSql('users', 'postgres', 5, 'id > 1'), 'postgres').reasons).toEqual([])
    expect(inspect(countSql('users', 'mysql', undefined), 'mysql').reasons).toEqual([])
    expect(inspect(countSql('users', 'postgres', '1=1; delete from users'), 'postgres').statements).toBeGreaterThan(1)
  })
})
