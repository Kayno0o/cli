import type { Terminal } from '../src/prompt'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'bun:test'
import { Exit } from '../src/args'
import { checklist, confirm, editor, input, select } from '../src/prompt'
import { stripAnsi } from '../src/text'

const CHOICES = [
  { value: 'a', label: 'alpha', hint: 'the first' },
  { value: 'b', label: 'beta', hint: 'the second' },
  { value: 'c', label: 'gamma', hint: 'the third' },
]

const DOWN = '\x1B[B'
const UP = '\x1B[A'
const ERASE = '\x7F'

// What a promise rejects with, undefined when it resolves.
async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error) {
    return error
  }

  return undefined
}

const TRAILING_RETURN = /\r$/

// A raw-mode terminal that sends `keys` one chunk at a time once the prompt listens, and keeps what it draws as written and with colour and cursor codes stripped.
function terminal(keys: string[], { columns = 80, rows = 24, tty = true } = {}) {
  const input = new EventEmitter()
  const raw: string[] = []
  const written: string[] = []
  const modes: boolean[] = []
  const fake = {
    stdin: Object.assign(input, {
      isTTY: tty,
      setRawMode: (mode: boolean) => modes.push(mode),
      resume: () => {
        queueMicrotask(() => {
          for (const key of keys)
            input.emit('data', Buffer.from(key))
        })
      },
      pause: () => undefined,
    }),
    stderr: { isTTY: true, columns, rows, write: (text: string) => raw.push(text) && written.push(stripAnsi(text).replace(TRAILING_RETURN, '')) },
  } as unknown as Terminal

  return { fake, raw, written, modes, listeners: () => input.listenerCount('data') }
}

// The frame drawn last before the answer, its lines without the redraw codes.
function lastFrame(written: string[]): string[] {
  return written.at(-3)!.split('\n')
}

describe('select', () => {
  it('picks the choice the arrows land on with Enter, wrapping around the ends', async () => {
    expect(await select('pick', CHOICES, { terminal: terminal([DOWN, DOWN, '\r']).fake })).toBe('c')
    expect(await select('pick', CHOICES, { terminal: terminal([UP, '\r']).fake })).toBe('c')
    expect(await select('pick', CHOICES, { initial: 1, terminal: terminal(['\x1BOA', '\n']).fake })).toBe('a')
  })

  it('moves with ctrl-n and leaves out the keys only the picker takes (f1, ctrl-/, tab)', async () => {
    expect(await select('pick', CHOICES, { terminal: terminal([`\x0E\x1BOP\x1F\t\r`]).fake })).toBe('b')
  })

  it('reads several keys sent in one chunk, the sequences it does not take left out', async () => {
    expect(await select('pick', CHOICES, { terminal: terminal([`${DOWN}\x1B[15~${DOWN}\r`]).fake })).toBe('c')
  })

  it('filters on every word typed, in the label or the hint, case ignored', async () => {
    expect(await select('pick', CHOICES, { terminal: terminal(['TH', 'ird', '\r']).fake })).toBe('c')
    expect(await select('pick', CHOICES, { terminal: terminal(['the sec\r']).fake })).toBe('b')
    expect(await select('pick', CHOICES, { terminal: terminal(['e', DOWN, '\r']).fake })).toBe('b')
  })

  it('keeps the cursor on its choice while it still matches, else goes to the first match', async () => {
    expect(await select('pick', CHOICES, { initial: 2, terminal: terminal(['a', '\r']).fake })).toBe('c')
    expect(await select('pick', CHOICES, { initial: 2, terminal: terminal(['b', '\r']).fake })).toBe('b')
  })

  it('edits the filter with Backspace, and takes no Enter while nothing matches', async () => {
    const { fake, written } = terminal(['zz', '\r', ERASE, ERASE, 'beta', '\r'])

    expect(await select('pick', CHOICES, { terminal: fake })).toBe('b')
    expect(written.some(frame => frame.includes('no match'))).toBe(true)
  })

  it('erases a word of the filter with Ctrl+W or Ctrl+Backspace, and all of it with Ctrl+U', async () => {
    expect(await select('pick', CHOICES, { terminal: terminal(['the third', '\x17', '\b', 'gam\r']).fake })).toBe('c')
    expect(await select('pick', CHOICES, { terminal: terminal(['bta', '\x1B[D', '\x1B[D', 'e\r']).fake })).toBe('b')
    expect(await select('pick', CHOICES, { terminal: terminal(['zz', '\x15', 'beta\r']).fake })).toBe('b')
  })

  it('takes a character of several bytes as one, and erases it whole', async () => {
    const choices = [{ value: 1, label: 'café', hint: '' }, { value: 2, label: 'cafe', hint: '' }]

    expect(await select('pick', choices, { terminal: terminal(['caf😀', ERASE, 'é\r']).fake })).toBe(1)
  })

  it('answers undefined once Escape or Ctrl+C cancels, and says so', async () => {
    const escaped = terminal([DOWN, '\x1B'])

    expect(await select('pick', CHOICES, { terminal: escaped.fake })).toBeUndefined()
    expect(await select('pick', CHOICES, { terminal: terminal(['\x03']).fake })).toBeUndefined()
    expect(escaped.written.at(-2)).toEndWith('✗ pick cancelled')
  })

  it('gives the terminal back as it found it once answered, leaving a ✓ line', async () => {
    const { fake, raw, written, modes, listeners } = terminal(['\r'])

    await select('pick', CHOICES, { terminal: fake })

    expect(modes).toEqual([true, false])
    expect(listeners()).toBe(0)
    expect(raw[0]).toBe('\x1B[?25l\x1B[?2004h')
    expect(raw.at(-1)).toBe('\n\x1B[?25h\x1B[?2004l')
    expect(written.at(-2)).toEndWith('✓ pick alpha')
  })

  it('cuts each hint to the terminal\'s width so no row wraps', async () => {
    const { fake, written } = terminal(['\r'], { columns: 20 })

    await select('pick', [{ value: 1, label: 'one', hint: 'a hint far longer than twenty columns' }], { terminal: fake })

    const [, row] = written[1]!.split('\n')

    expect(row).toBe('❯ one  a hint far …')
  })

  it('scrolls a long list in a window following the cursor, counting what it hides', async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ value: index, label: `item ${index}`, hint: '' }))
    const { fake, written } = terminal([UP, '\r'], { rows: 8 })

    expect(await select('pick', many, { terminal: fake })).toBe(29)

    const [first] = written[1]!.split('\n').slice(1)
    const frame = lastFrame(written)

    expect(first).toBe('❯ item 0   ')
    expect(frame).toHaveLength(7)
    expect(frame[1]).toBe('  … 25 more')
    expect(frame.at(-1)).toBe('❯ item 29  ')
  })

  it('takes a terminal saying its size is 0 as 80 by 24', async () => {
    const { fake, written } = terminal(['\r'], { columns: 0, rows: 0 })

    await select('pick', CHOICES, { terminal: fake })

    expect(written[1]!.split('\n')).toHaveLength(4)
  })

  it('fails with exit 2 off a terminal, the caller\'s hint under it, drawing nothing', async () => {
    const { fake, written } = terminal(['\r'], { tty: false })
    const refused = await thrown(select('Start from', CHOICES, { hint: 'pass --preset', terminal: fake }))

    expect(refused).toBeInstanceOf(Exit)
    expect(refused).toMatchObject({ message: 'cannot ask "Start from" off a terminal', code: 2, hint: 'pass --preset' })
    expect(written).toEqual([])
  })
})

describe('select default', () => {
  it('starts the cursor on the choice holding the value, else on initial', async () => {
    expect(await select('pick', CHOICES, { default: 'c', terminal: terminal(['\r']).fake })).toBe('c')
    expect(await select('pick', CHOICES, { default: 'c', initial: 1, terminal: terminal(['\r']).fake })).toBe('c')
    expect(await select('pick', CHOICES, { default: 'x', initial: 1, terminal: terminal(['\r']).fake })).toBe('b')
  })
})

describe('checklist', () => {
  it('checks and unchecks with Space, and accepts with Enter', async () => {
    const checked = await checklist('pick', CHOICES, { initial: new Set(['a']), terminal: terminal([' ', DOWN, ' ', DOWN, ' ', ' ', '\r']).fake })

    expect([...checked!]).toEqual(['b'])
  })

  it('toggles through the toggle given, which may change other choices along', async () => {
    const all = (checked: ReadonlySet<string>, value: string) => checked.has(value) ? new Set<string>() : new Set(CHOICES.map(choice => choice.value))

    expect([...(await checklist('pick', CHOICES, { toggle: all, terminal: terminal([' ', '\r']).fake }))!]).toEqual(['a', 'b', 'c'])
  })

  it('toggles the choice the filter leaves under the cursor, and keeps what it hides checked', async () => {
    const checked = await checklist('pick', CHOICES, { initial: new Set(['a']), terminal: terminal(['gam', ' ', '\r']).fake })

    expect([...checked!]).toEqual(['a', 'c'])
  })

  it('draws ◉ on a checked choice and ◯ on the others, and lists what was accepted, or none', async () => {
    const some = terminal([DOWN, ' ', '\r'])
    const none = terminal(['\r'])

    await checklist('pick', CHOICES, { initial: new Set(['c']), terminal: some.fake })
    await checklist('pick', CHOICES, { terminal: none.fake })

    expect(lastFrame(some.written).slice(1)).toEqual(['  ◯ alpha  the first', '❯ ◉ beta   the second', '  ◉ gamma  the third'])
    expect(some.written.at(-2)).toEndWith('✓ pick beta, gamma')
    expect(none.written.at(-2)).toEndWith('✓ pick none')
  })

  it('keeps asking on fewer ticks than min, with a message under the list until the next key', async () => {
    const { fake, written } = terminal(['\r', ' ', '\r'])
    const checked = await checklist('pick', CHOICES, { min: 1, terminal: fake })

    expect([...checked!]).toEqual(['a'])
    expect(written[2]!.split('\n').at(-1)).toBe('  pick at least 1')
    expect(written[3]!.split('\n')).not.toContain('  pick at least 1')
  })

  it('answers undefined once cancelled, whatever was checked', async () => {
    expect(await checklist('pick', CHOICES, { terminal: terminal([' ', '\x1B']).fake })).toBeUndefined()
  })
})

describe('confirm', () => {
  it('answers y or n, whatever the case', async () => {
    expect(await confirm('go?', { terminal: terminal(['Y']).fake })).toBe(true)
    expect(await confirm('go?', { default: true, terminal: terminal(['n']).fake })).toBe(false)
  })

  it('takes the default on Enter, and waits for a letter without one', async () => {
    const waiting = terminal(['\r', 'x', 'y'])

    expect(await confirm('go?', { default: false, terminal: terminal(['\r']).fake })).toBe(false)
    expect(await confirm('go?', { terminal: waiting.fake })).toBe(true)
    expect(waiting.written[1]).toBe('\r? go? (y/n)')
    expect(waiting.written.at(-2)).toEndWith('✓ go? yes')
  })

  it('says which answer Enter takes', async () => {
    const yes = terminal(['\r'])

    await confirm('go?', { default: true, terminal: yes.fake })

    expect(yes.written[1]).toEndWith('? go? (Y/n)')
  })

  it('answers undefined once cancelled', async () => {
    expect(await confirm('go?', { default: true, terminal: terminal(['\x03']).fake })).toBeUndefined()
  })

  it('answers undefined once stdin ends unanswered, listening no more', async () => {
    const { fake, listeners } = terminal([])
    const asked = confirm('go?', { default: true, terminal: fake })

    queueMicrotask(() => (fake.stdin as unknown as EventEmitter).emit('end'))

    expect(await asked).toBeUndefined()
    expect(listeners()).toBe(0)
  })

  it('fails off a terminal', async () => {
    expect(await thrown(confirm('go?', { hint: 'pass --yes', terminal: terminal([], { tty: false }).fake }))).toMatchObject({ code: 2, hint: 'pass --yes' })
  })
})

describe('input', () => {
  it('takes the line typed, a paste in one chunk included, Backspace erasing', async () => {
    expect(await input('name', { terminal: terminal(['ad', 'x', ERASE, 'a lovelace', '\r']).fake })).toBe('ada lovelace')
  })

  it('takes the default for an empty line, shown until something is typed', async () => {
    const { fake, written } = terminal(['\r'])

    expect(await input('name', { default: 'ada', terminal: fake })).toBe('ada')
    expect(written[1]).toEndWith('? name ada█')
  })

  it('masks what is typed with mask, in the answer left too', async () => {
    const { fake, written } = terminal(['s3cret\r'])

    expect(await input('token', { mask: true, terminal: fake })).toBe('s3cret')
    expect(written.join('')).not.toContain('s3cret')
    expect(written.at(-2)).toEndWith('✓ token ******')
  })

  it('keeps asking while validate answers a message, shown under the line until the next key', async () => {
    const { fake, written } = terminal(['\r', 'a', '\r'])
    const validate = (value: string) => value === '' ? 'give a name' : undefined

    expect(await input('name', { validate, terminal: fake })).toBe('a')
    expect(written[2]!.split('\n')).toEqual(['\r? name █', '  give a name'])
    expect(written[3]).toBe('\r? name a█')
  })

  it('shows the end of a line longer than the terminal, so it never wraps', async () => {
    const { fake, written } = terminal(['abcdefghijklmnopqrstuvwxyz', '\r'], { columns: 20 })

    await input('name', { terminal: fake })

    expect(written.at(-3)).toBe('\r? name …qrstuvwxyz█')
  })

  it('erases a word with Ctrl+W, Ctrl+Backspace or Alt+Backspace, and the line with Ctrl+U', async () => {
    expect(await input('name', { terminal: terminal(['ada king lovelace', '\x17', '\b', 'byron', '\r']).fake })).toBe('ada byron')
    expect(await input('name', { terminal: terminal(['ada king ', '\x1B\x7F', 'x', '\x15', 'ada\r']).fake })).toBe('ada')
  })

  it('moves the caret with the arrows, Home and End, typing and deleting where it stands', async () => {
    const LEFT = '\x1B[D'

    expect(await input('url', { terminal: terminal(['https://ex.fr/rest', LEFT, 'e', '\x1B[F', '/1', '\x1B[H', '\x1B[3~', 'H\r']).fake })).toBe('Https://ex.fr/reset/1')
    expect(await input('name', { terminal: terminal(['ada byron', '\x1B[1;5D', '\x0B', 'lovelace\r']).fake })).toBe('ada lovelace')
  })

  it('draws the character under the caret reversed, cut around it when the line is long', async () => {
    const { fake, raw, written } = terminal(['abcdefghijklmnopqrstuvwxyz', '\x01', '\r'], { columns: 20 })

    await input('name', { terminal: fake })

    expect(written.at(-3)).toBe('\r? name abcdefghijk…')
    expect(raw.at(-3)).toContain('\x1B[7ma\x1B[27m')
  })

  it('climbs back the rows a question wider than the terminal wraps to, so a key redraws it in place', async () => {
    const question = 'a question of forty characters, or more'
    const { fake, raw, written } = terminal(['abc', '\r'], { columns: 20 })

    await input(question, { terminal: fake })

    expect(raw[2]).toContain('\x1B[2A')
    expect(written.at(-3)).toBe(`\r? ${question} abc█`)
  })

  it('shows the end of what is typed in the room the wrapped question leaves on its last row', async () => {
    const { fake, written } = terminal(['abcdefghijklmnopqrstuvwxyz', '\r'], { columns: 20 })

    await input('a question of thirty chars ok', { terminal: fake })

    expect(written.at(-3)).toBe('\r? a question of thirty chars ok …vwxyz█')
  })

  it('answers undefined once cancelled', async () => {
    expect(await input('name', { terminal: terminal(['ada', '\x1B']).fake })).toBeUndefined()
  })
})

describe('editor', () => {
  it('answers the file as the editor left it, started on the default', async () => {
    const { fake, written } = terminal([])

    expect(await editor('notes', { default: 'draft\n', env: { EDITOR: 'sed -i s/draft/final/' }, terminal: fake })).toBe('final\n')
    expect(written).toEqual(['? notes (sed -i s/draft/final/)\n', '✓ notes edited\n'])
  })

  it('names the file with the extension and prefers VISUAL to EDITOR', async () => {
    const edited = await editor('notes', { extension: '.md', env: { VISUAL: 'sh -c \'basename "$0" > "$0"\'', EDITOR: 'false' }, terminal: terminal([]).fake })

    expect(edited).toBe('edit.md\n')
  })

  it('answers undefined when the editor exits nonzero', async () => {
    const { fake, written } = terminal([])

    expect(await editor('notes', { env: { EDITOR: 'false' }, terminal: fake })).toBeUndefined()
    expect(written.at(-1)).toBe('✗ notes cancelled\n')
  })

  it('fails off a terminal', async () => {
    expect(await thrown(editor('notes', { terminal: terminal([], { tty: false }).fake }))).toBeInstanceOf(Exit)
  })
})

describe('a resize while asking', () => {
  it('redraws from the first line, erasing down however many rows the frame now takes', async () => {
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => undefined, resume: () => undefined, pause: () => undefined })
    const raw: string[] = []
    const stderr = Object.assign(new EventEmitter(), { isTTY: true, columns: 80, rows: 24, write: (text: string) => raw.push(text) })
    const running = input('a question that is quite long indeed, forty or so', { terminal: { stdin, stderr } as unknown as Terminal })

    raw.length = 0
    stderr.columns = 20
    stderr.emit('resize')

    expect(raw.join('')).toStartWith('\x1B[?2026h\r')
    expect(raw.join('')).toContain('\x1B[0J')

    stdin.emit('data', Buffer.from('\x03'))
    await running
  })
})

describe('a redraw', () => {
  it('overwrites each row and erases only past it, so the frame never shows blank', async () => {
    const { fake, raw } = terminal([DOWN, '\r'])

    await select('pick', CHOICES, { terminal: fake })

    const moved = raw[2]!

    expect(moved).toStartWith('\x1B[?2026h\r')
    expect(moved).toEndWith('\x1B[?2026l')
    expect(moved.indexOf('\x1B[0J')).toBeGreaterThan(moved.lastIndexOf('\n'))
    expect(moved.split('\n').every(line => line.includes('\x1B[K'))).toBe(true)
  })

  it('erases what a wrapped line leaves of its last row after it', async () => {
    const { fake, raw } = terminal(['\r'], { columns: 16 })

    await input('a question longer than one row', { terminal: fake })

    expect(raw[1]).not.toContain('\x1B[2K')
    expect(raw[1]).toContain('\x1B[K\x1B[0J')
  })

  it('erases a row a line fills exactly before writing it, as an erase after would take its last cell', async () => {
    const { fake, raw } = terminal(['\r'], { columns: 16 })

    await input('twelve chars', { terminal: fake })

    expect(raw[1]).toContain('\x1B[2K')
  })
})

describe('paging and pasting', () => {
  const MANY = Array.from({ length: 25 }, (_, index) => ({ value: index, label: `item ${index}`, hint: '' }))

  it('End and Home jump to the last choice and the first, the pages stopping at the ends', async () => {
    expect(await select('pick', MANY, { terminal: terminal(['\x1B[F', '\r']).fake })).toBe(24)
    expect(await select('pick', MANY, { terminal: terminal(['\x1B[6~', '\x1B[6~', '\x1B[6~', '\x1B[5~', '\r']).fake })).toBe(14)
    expect(await select('pick', MANY, { terminal: terminal(['\x1B[F', '\x1B[H', '\r']).fake })).toBe(0)
  })

  it('a pasted line break is dropped instead of answering the prompt', async () => {
    expect(await input('name', { terminal: terminal(['\x1B[200~one\ntwo\x1B[201~', '\r']).fake })).toBe('onetwo')
  })
})
