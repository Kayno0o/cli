import { describe, expect, spyOn, test } from 'bun:test'
import { byRecency, emit, list, pick } from '../src/picker'

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

describe('the protocol tmux_pick reads', () => {
  function printed(print: () => void): string {
    const lines: string[] = []
    const log = spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line))

    try {
      print()
    }
    finally {
      log.mockRestore()
    }

    return lines.join('\n')
  }

  test('list prints the rows as one JSON array', () => {
    const rows = [{ label: 'dev', hint: 'up', typed: 'dev', preview: ['--show', 'dev'], actions: [{ label: 'Fetch', key: 'ctrl-r', reload: ['--fetch'] }] }]

    expect(JSON.parse(printed(() => list(rows)))).toEqual(rows)
  })

  test('emit prints the mode, the words typed back, the id recorded and one line per word of the command', () => {
    expect(printed(() => emit('run', 'dev logs', 'dev', ['docker', { given: 'web' }, { ask: 'name' }]))).toBe('run\ndev logs\ndev\n=docker\n+web\n?name')
    expect(printed(() => emit('edit', 'x', '', []))).toBe('edit\nx\n')
  })
})
