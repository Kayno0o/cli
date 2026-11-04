import { describe, expect, test } from 'bun:test'
import { byRecency, pick } from '../src/picker'

describe('byRecency', () => {
  test('puts the ones run last first, the rest keeping their order', () => {
    const runs = [{ id: 'web', args: ['logs'] }, { id: 'db', args: ['up'] }]

    expect(byRecency(['api', 'db', 'web', 'cache'], runs, name => name)).toEqual(['web', 'db', 'api', 'cache'])
    expect(byRecency(['api', 'db'], [], name => name)).toEqual(['api', 'db'])
  })
})

describe('pick', () => {
  test('refuses a key it cannot report and a bad height before opening anything', async () => {
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(pick([], { prompt: '> ', expect: ['ctrl-c'] })).rejects.toThrow('ctrl-c')
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(pick([], { prompt: '> ', reload: { key: 'enter', run: () => ({ rows: [] }) } })).rejects.toThrow('enter')
    // eslint-disable-next-line ts/await-thenable -- bun types .rejects as void
    await expect(pick([], { prompt: '> ', height: 'tall' })).rejects.toThrow('height')
  })
})
