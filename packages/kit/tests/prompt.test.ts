import type { Terminal } from '../src/prompt'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'bun:test'
import { checklist, select } from '../src/prompt'

const CHOICES = [
  { value: 'a', label: 'alpha', hint: 'the first' },
  { value: 'b', label: 'beta', hint: 'the second' },
  { value: 'c', label: 'gamma', hint: 'the third' },
]

// A raw-mode terminal that sends `keys` one chunk at a time once the prompt listens, and keeps what it draws.
function terminal(keys: string[], columns = 80) {
  const input = new EventEmitter()
  const written: string[] = []
  const modes: boolean[] = []
  const fake = {
    stdin: Object.assign(input, {
      setRawMode: (mode: boolean) => modes.push(mode),
      resume: () => {
        queueMicrotask(() => {
          for (const key of keys)
            input.emit('data', Buffer.from(key))
        })
      },
      pause: () => undefined,
    }),
    stderr: { columns, write: (text: string) => written.push(text) },
  } as unknown as Terminal

  return { fake, written, modes, listeners: () => input.listenerCount('data') }
}

describe('select', () => {
  it('picks the choice the arrows land on with Enter, wrapping around the ends', async () => {
    expect(await select('pick', CHOICES, 0, terminal(['\x1B[B', '\x1B[B', '\r']).fake)).toBe('c')
    expect(await select('pick', CHOICES, 0, terminal(['\x1B[A', '\r']).fake)).toBe('c')
    expect(await select('pick', CHOICES, 2, terminal(['j', '\r']).fake)).toBe('a')
    expect(await select('pick', CHOICES, 1, terminal(['\x1BOA', '\n']).fake)).toBe('a')
  })

  it('reads several keys sent in one chunk, the ones it does not take left out', async () => {
    expect(await select('pick', CHOICES, 0, terminal(['jx\x1B[Hj\r']).fake)).toBe('c')
  })

  it('answers undefined once Escape or Ctrl+C cancels, and says so', async () => {
    const escaped = terminal(['j', '\x1B'])

    expect(await select('pick', CHOICES, 0, escaped.fake)).toBeUndefined()
    expect(await select('pick', CHOICES, 0, terminal(['\x03']).fake)).toBeUndefined()
    expect(escaped.written.join('')).toContain('pick cancelled')
  })

  it('gives the terminal back as it found it once answered', async () => {
    const { fake, written, modes, listeners } = terminal(['\r'])

    await select('pick', CHOICES, 0, fake)

    expect(modes).toEqual([true, false])
    expect(listeners()).toBe(0)
    expect(written[0]).toBe('\x1B[?25l')
    expect(written.at(-1)).toBe('\n\x1B[?25h')
    expect(written.at(-2)).toEndWith('? pick alpha')
  })

  it('cuts each hint to the terminal\'s width so no row wraps', async () => {
    const { fake, written } = terminal(['\r'], 20)

    await select('pick', [{ value: 1, label: 'one', hint: 'a hint far longer than twenty columns' }], 0, fake)

    const [, row] = written[1]!.split('\n')

    expect(row).toBe('> one  a hint fa...')
  })
})

describe('checklist', () => {
  const toggle = (checked: ReadonlySet<string>, value: string) => {
    const next = new Set(checked)

    if (!next.delete(value))
      next.add(value)

    return next
  }

  it('checks and unchecks with Space through toggle, and accepts with Enter', async () => {
    const checked = await checklist('pick', CHOICES, new Set(['a']), toggle, terminal([' ', 'j', ' ', 'j', ' ', ' ', '\r']).fake)

    expect([...checked!]).toEqual(['b'])
  })

  it('lists what was accepted, or none', async () => {
    const some = terminal(['j', ' ', '\r'])
    const none = terminal(['\r'])

    await checklist('pick', CHOICES, new Set(['c']), toggle, some.fake)
    await checklist('pick', CHOICES, new Set(), toggle, none.fake)

    expect(some.written.at(-2)).toEndWith('? pick beta, gamma')
    expect(none.written.at(-2)).toEndWith('? pick none')
  })

  it('answers undefined once cancelled, whatever was checked', async () => {
    expect(await checklist('pick', CHOICES, new Set(), toggle, terminal([' ', '\x1B']).fake)).toBeUndefined()
  })
})
