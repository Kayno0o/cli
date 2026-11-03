import { describe, expect, test } from 'bun:test'
import { byRecency } from '../src/fzf'

describe('byRecency', () => {
  test('puts the ones run last first, the rest keeping their order', () => {
    const runs = [{ id: 'web', args: ['logs'] }, { id: 'db', args: ['up'] }]

    expect(byRecency(['api', 'db', 'web', 'cache'], runs, name => name)).toEqual(['web', 'db', 'api', 'cache'])
    expect(byRecency(['api', 'db'], [], name => name)).toEqual(['api', 'db'])
  })
})
