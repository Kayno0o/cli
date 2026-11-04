import type { Terminal } from '../../src/picker/terminal'
import { describe, expect, test } from 'bun:test'
import { select } from '../../src/picker/terminal'

const ROWS = [
  { hidden: ['id-1'], cells: ['install-hooks', 'adds the hooks'] },
  { hidden: ['id-2'], cells: ['install', 'adds the packages'] },
  { hidden: ['id-3'], cells: ['doctor', 'checks'] },
]
const HEIGHT = { lines: 8 }
const plain = (text: string): string => text

// A terminal whose keys the test types once the picker listens.
function fake(): { terminal: Terminal, type: (text: string) => void, written: string[], closed: () => boolean } {
  let onChunk: (chunk: string) => void = plain
  let closed = false
  const written: string[] = []
  const terminal: Terminal = {
    columns: 60,
    rows: 20,
    theme: { accent: plain, label: plain, value: plain, id: plain },
    write: text => void written.push(text),
    listen: (chunk) => {
      onChunk = chunk
    },
    close: () => {
      closed = true
    },
  }

  return { terminal, type: text => onChunk(text), written, closed: () => closed }
}

function settings(more: object = {}) {
  return { multi: false, prompt: '> ', query: '', height: HEIGHT, preview: undefined, searched: 1, ...more }
}

describe('select', () => {
  test('enter returns the highlighted row with its hidden fields and the query', async () => {
    const { terminal, type, closed } = fake()
    const running = select(ROWS, settings(), terminal)

    type('install')
    type('\r')

    expect(await running).toEqual({ rows: [ROWS[1]!], key: '', query: 'install' })
    expect(closed()).toBe(true)
  })

  test('an expected key ends the pick and says which, the query coming back', async () => {
    const { terminal, type } = fake()
    const running = select(ROWS, settings({ expect: ['ctrl-d', 'ctrl-n'] }), terminal)

    type('feat')
    type('\x0E')

    expect(await running).toEqual({ rows: [], key: 'ctrl-n', query: 'feat' })
  })

  test('an expected key picks the highlighted row too', async () => {
    const { terminal, type } = fake()
    const running = select(ROWS, settings({ expect: ['ctrl-d'] }), terminal)

    type('doc')
    type('\x04')

    expect(await running).toEqual({ rows: [ROWS[2]!], key: 'ctrl-d', query: 'doc' })
  })

  test('escape and ctrl-c cancel', async () => {
    const first = fake()
    const escaped = select(ROWS, settings(), first.terminal)

    first.type('\x1B')
    expect(await escaped).toBeUndefined()

    const second = fake()
    const interrupted = select(ROWS, settings(), second.terminal)

    second.type('x')
    second.type('\x03')
    expect(await interrupted).toBeUndefined()
    expect(second.closed()).toBe(true)
  })

  test('draws the header', async () => {
    const { terminal, type, written } = fake()
    const running = select(ROWS, settings({ header: 'where HEAD stands' }), terminal)

    type('\x1B')
    await running
    expect(written.join('')).toContain('where HEAD stands')
  })
})

describe('reload', () => {
  const FRESH = [{ hidden: ['id-9'], cells: ['install-new', 'fetched'] }]

  test('its key replaces the rows and the header in place and keeps the query', async () => {
    const { terminal, type, written } = fake()
    const running = select(ROWS, settings({ header: 'old', reload: { key: 'ctrl-r', run: () => ({ header: 'fetched', rows: FRESH }) } }), terminal)

    type('inst')
    type('\x12')
    await Bun.sleep(5)
    type('\r')

    expect(await running).toEqual({ rows: FRESH, key: '', query: 'inst' })
    expect(written.join('')).toContain('fetched')
  })

  test('an async reload holds the keys typed meanwhile until it is done', async () => {
    const { terminal, type } = fake()
    const running = select(ROWS, settings({ reload: { key: 'ctrl-r', run: async () => {
      await Bun.sleep(30)

      return { rows: FRESH }
    } } }), terminal)

    type('\x12')
    type('\r')

    expect(await running).toMatchObject({ rows: FRESH })
  })

  test('escape cancels while a reload is running', async () => {
    const { terminal, type } = fake()
    const running = select(ROWS, settings({ reload: { key: 'ctrl-r', run: async () => {
      await Bun.sleep(2000)

      return { rows: FRESH }
    } } }), terminal)

    type('\x12')
    type('\x1B')

    expect(await running).toBeUndefined()
  })

  test('onOpen reloads once the picker is open, without a key', async () => {
    const { terminal, type } = fake()
    const running = select(ROWS, settings({ reload: { onOpen: true, run: () => ({ rows: FRESH }) } }), terminal)

    await Bun.sleep(5)
    type('\r')

    expect(await running).toMatchObject({ rows: FRESH })
  })

  test('a failing reload is reported beside the counts and leaves the rows', async () => {
    const { terminal, type, written } = fake()
    const running = select(ROWS, settings({ reload: { key: 'ctrl-r', run: () => {
      throw new Error('no network')
    } } }), terminal)

    type('\x12')
    await Bun.sleep(5)
    type('\r')

    expect(await running).toMatchObject({ rows: [ROWS[0]!] })
    expect(written.join('')).toContain('reload failed: no network')
  })
})

describe('preview', () => {
  test('a function gets the hidden fields of the highlighted row and shows below the list', async () => {
    const { terminal, type, written } = fake()
    const running = select(ROWS, settings({ height: { lines: 20 }, previewPosition: 'down', preview: (hidden: string[]) => `about ${hidden[0]}` }), terminal)

    type('doctor')
    await Bun.sleep(300)
    type('\x1B')
    await running
    expect(written.join('')).toContain('about id-3')
  })

  test('a command gets the hidden fields as {1}', async () => {
    const { terminal, type, written } = fake()
    const running = select(ROWS, settings({ height: { lines: 20 }, previewPosition: 'down', preview: 'echo shown {1}' }), terminal)

    type('doctor')
    await Bun.sleep(400)
    type('\x1B')
    await running
    expect(written.join('')).toContain('shown id-3')
  })
})
