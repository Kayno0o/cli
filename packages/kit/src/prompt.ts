import type { Colors } from './style'
import process from 'node:process'
import { fail } from './args'
import { truncate } from './format'
import { paint } from './style'

// What the terminal sends for a key: a whole escape sequence, such as an arrow's or Home's, which no prompt but the arrows reads, or one character, a lone Escape included.
// eslint-disable-next-line no-control-regex -- escape sequences are what it splits
const KEY_SEQUENCES = /\x1B\[[0-9;]*[A-Z~]|\x1BO[A-Z]|[\s\S]/giu
// eslint-disable-next-line no-control-regex -- control characters are what it leaves out
const CONTROL = /^[\x00-\x1F\x7F]/
const WORDS = /\s+/
// Choices drawn at once at most, the rest scrolled to.
const MAX_ROWS = 10

type Key = 'up' | 'down' | 'enter' | 'cancel' | 'erase' | { text: string }
type Outcome = 'enter' | 'cancel'
type State = 'asking' | Outcome

const KEYS: Record<string, Key> = { '\x1B[A': 'up', '\x1BOA': 'up', '\x1B[B': 'down', '\x1BOB': 'down', '\r': 'enter', '\n': 'enter', '\x03': 'cancel', '\x1B': 'cancel', '\x7F': 'erase', '\b': 'erase' }

export interface Choice<T> {
  value: T
  label: string
  hint: string
}

// The ends a prompt reads keys from and draws on, the process's own by default.
export interface Terminal {
  stdin: Pick<NodeJS.ReadStream, 'setRawMode' | 'resume' | 'pause' | 'on' | 'off'> & { isTTY?: boolean }
  stderr: Pick<NodeJS.WriteStream, 'write' | 'columns' | 'rows'> & { isTTY?: boolean }
}

export interface PromptSettings {
  // Shown under the error a prompt fails with off a terminal, such as `pass --yes`.
  hint?: string
  terminal?: Terminal
}

// The keys a chunk of terminal input holds, in order: the ones prompts read, and printable text.
function readKeys(input: string): Key[] {
  return (input.match(KEY_SEQUENCES) ?? []).flatMap(sequence => KEYS[sequence] ?? (CONTROL.test(sequence) ? [] : [{ text: sequence }]))
}

export interface SelectSettings extends PromptSettings {
  // The index of the choice the cursor starts on.
  initial?: number
}

// One choice among several, typing filtering them, the arrows moving and Enter picking; undefined once Escape or Ctrl+C cancels.
export async function select<T>(question: string, choices: Choice<T>[], { initial = 0, ...settings }: SelectSettings = {}): Promise<T | undefined> {
  const list = new List(choices, initial)
  const picked = await ask(question, settings, (colors, state, rows) => state === 'asking'
    ? [asking(colors, question, list.query, 'type to filter, enter picks'), ...list.rows(colors, rows, () => '')]
    : [answer(colors, question, state, list.current()?.label ?? '')], (key) => {
    if (key === 'enter')
      return list.current() === undefined ? undefined : 'enter'

    if (key === 'cancel')
      return 'cancel'

    list.press(key)

    return undefined
  })

  return picked ? list.current()?.value : undefined
}

export interface ChecklistSettings<T> extends PromptSettings {
  initial?: ReadonlySet<T>
  // What checking or unchecking `value` leaves checked, which may change other choices along; flips `value` alone by default.
  toggle?: (checked: ReadonlySet<T>, value: T) => ReadonlySet<T>
}

function flip<T>(checked: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(checked)

  if (!next.delete(value))
    next.add(value)

  return next
}

// Several choices, typing filtering them, Space checking or unchecking the one under the cursor and Enter accepting what is checked; undefined once cancelled.
export async function checklist<T>(question: string, choices: Choice<T>[], { initial = new Set(), toggle = flip, ...settings }: ChecklistSettings<T> = {}): Promise<ReadonlySet<T> | undefined> {
  const list = new List(choices, 0)
  let checked = initial
  const accepted = await ask(question, settings, (colors, state, rows) => state === 'asking'
    ? [asking(colors, question, list.query, 'type to filter, space toggles, enter accepts'), ...list.rows(colors, rows, choice => checked.has(choice.value) ? `${colors.cyan('◉')} ` : `${colors.dim('◯')} `)]
    : [answer(colors, question, state, choices.filter(choice => checked.has(choice.value)).map(choice => choice.label).join(', ') || 'none')], (key) => {
    if (key === 'enter' || key === 'cancel')
      return key

    const current = list.current()

    if (typeof key === 'object' && key.text === ' ') {
      if (current !== undefined)
        checked = toggle(checked, current.value)

      return undefined
    }

    list.press(key)

    return undefined
  })

  return accepted ? checked : undefined
}

export interface ConfirmSettings extends PromptSettings {
  // What Enter answers; without one, Enter waits for y or n.
  default?: boolean
}

// A yes or no, y or n answering it and Enter taking the default; undefined once cancelled.
export async function confirm(question: string, { default: fallback, ...settings }: ConfirmSettings = {}): Promise<boolean | undefined> {
  let answered = fallback
  const choices = { true: 'Y/n', false: 'y/N', undefined: 'y/n' }[String(fallback) as 'true' | 'false' | 'undefined']
  const accepted = await ask(question, settings, (colors, state) => [state === 'asking' ? asking(colors, question, '', choices) : answer(colors, question, state, answered ? 'yes' : 'no')], (key) => {
    if (key === 'cancel')
      return 'cancel'

    if (key === 'enter')
      return answered === undefined ? undefined : 'enter'

    const letter = typeof key === 'object' ? key.text.toLowerCase() : ''

    if (letter !== 'y' && letter !== 'n')
      return undefined

    answered = letter === 'y'

    return 'enter'
  })

  return accepted ? answered : undefined
}

export interface InputPromptSettings extends PromptSettings {
  // What an empty answer stands for, shown dimmed until something is typed.
  default?: string
  // Draws each character typed as `*`, for a password or a token.
  mask?: boolean
  // What is wrong with the answer, shown under it until Enter is pressed on one it takes; undefined takes it.
  validate?: (value: string) => string | undefined
}

// A line of text, Enter taking it once `validate` does; undefined once cancelled.
export async function input(question: string, { default: fallback, mask = false, validate, ...settings }: InputPromptSettings = {}): Promise<string | undefined> {
  let value = ''
  let invalid: string | undefined
  const taken = () => value === '' ? fallback ?? '' : value
  const shown = () => mask ? '*'.repeat([...taken()].length) : taken()
  const accepted = await ask(question, settings, (colors, state, { columns }) => {
    if (state !== 'asking')
      return [answer(colors, question, state, shown())]

    // Its end alone where it would wrap: `? `, the question, a space, the caret, and the last column kept free.
    const characters = [...shown()]
    const room = Math.max(columns - question.length - 5, 1)
    const tail = characters.length > room ? `…${characters.slice(1 - room).join('')}` : shown()
    const typed = value === '' ? colors.dim(tail) : tail

    return [`${colors.cyan('?')} ${question} ${typed}${colors.dim('█')}`, ...invalid === undefined ? [] : [`  ${colors.red(invalid)}`]]
  }, (key) => {
    if (key === 'cancel')
      return 'cancel'

    invalid = undefined

    if (key === 'enter') {
      invalid = validate?.(taken())

      return invalid === undefined ? 'enter' : undefined
    }

    if (key === 'erase')
      value = [...value].slice(0, -1).join('')
    else if (typeof key === 'object')
      value += key.text

    return undefined
  })

  return accepted ? taken() : undefined
}

// The choices a filter leaves, the cursor on one of them and the window of rows drawn around it.
class List<T> {
  query = ''
  private matches: Choice<T>[]
  private cursor: number
  private top = 0
  private readonly width: number

  constructor(private readonly choices: Choice<T>[], initial: number) {
    this.matches = choices
    this.cursor = Math.min(Math.max(initial, 0), choices.length - 1)
    this.width = Math.max(0, ...choices.map(choice => choice.label.length))
  }

  current(): Choice<T> | undefined {
    return this.matches[this.cursor]
  }

  press(key: Key): void {
    if (key === 'up' || key === 'down') {
      if (this.matches.length > 0)
        this.cursor = (this.cursor + (key === 'up' ? this.matches.length - 1 : 1)) % this.matches.length

      return
    }

    if (key === 'erase')
      this.filter([...this.query].slice(0, -1).join(''))
    else if (typeof key === 'object')
      this.filter(this.query + key.text)
  }

  // Every word typed is in the label or the hint, case ignored; the cursor stays on its choice while it still matches, else goes to the first.
  private filter(query: string): void {
    const words = query.toLowerCase().split(WORDS).filter(word => word !== '')
    const current = this.current()

    this.query = query
    this.matches = this.choices.filter(({ label, hint }) => words.every(word => `${label} ${hint}`.toLowerCase().includes(word)))
    this.cursor = current === undefined ? 0 : Math.max(this.matches.indexOf(current), 0)
    this.top = 0
  }

  // A line per choice in the window, each cut to the terminal's width so none wraps, which would throw off the redraw, and a dimmed count of those scrolled past.
  rows(colors: Colors, { columns, rows }: { columns: number, rows: number }, marker: (choice: Choice<T>) => string): string[] {
    if (this.matches.length === 0)
      return [colors.dim('  no match')]

    const height = Math.max(1, Math.min(MAX_ROWS, rows - 3, this.matches.length))

    this.top = Math.min(Math.max(this.top, this.cursor - height + 1), this.cursor)

    const shown = this.matches.slice(this.top, this.top + height).map((choice, index) => {
      const here = this.top + index === this.cursor
      const mark = marker(choice)
      const head = `${here ? '❯' : ' '} ${mark}`
      const label = choice.label.padEnd(this.width)
      // What is left of the line for the hint: the pointer and a space, a mark of two visible characters (`◉ `) when there is one, the label, two spaces, and the last column kept free.
      const room = columns - 5 - (mark === '' ? 0 : 2) - this.width

      return `${here ? colors.cyan(head) : head}${here ? colors.cyan(label) : label}  ${colors.dim(truncate(choice.hint, Math.max(room, 0)))}`
    })
    const below = this.matches.length - this.top - height

    return [...this.top > 0 ? [colors.dim(`  … ${this.top} more`)] : [], ...shown, ...below > 0 ? [colors.dim(`  … ${below} more`)] : []]
  }
}

// The question line while asking: what was typed after it, else a dimmed note of the keys.
function asking(colors: Colors, question: string, typed: string, keys: string): string {
  return `${colors.cyan('?')} ${question} ${typed === '' ? colors.dim(`(${keys})`) : typed}`
}

// The line a prompt leaves once answered: what was picked, or that it was cancelled.
function answer(colors: Colors, question: string, state: Outcome, picked: string): string {
  return state === 'enter' ? `${colors.green('✓')} ${question} ${colors.cyan(picked)}` : `${colors.red('✗')} ${question} ${colors.dim('cancelled')}`
}

type Render = (colors: Colors, state: State, size: { columns: number, rows: number }) => string[]

// Draws a prompt on stderr and redraws it after each key stdin sends raw, until `press` answers `enter` or `cancel`; true once entered. Off a terminal, nobody could answer, so it fails at once.
async function ask(question: string, { hint, terminal = process }: PromptSettings, render: Render, press: (key: Key) => Outcome | undefined): Promise<boolean> {
  const { stdin, stderr } = terminal

  if (stdin.isTTY !== true || stderr.isTTY !== true)
    fail(`cannot ask "${question}" off a terminal`, 2, hint)

  const colors = paint(stderr)
  let drawn = 0
  let outcome: Outcome | undefined
  const draw = (state: State) => {
    // A terminal that does not say its size, as a pseudo-terminal may, answers 0.
    const frame = render(colors, state, { columns: stderr.columns || 80, rows: stderr.rows || 24 })

    stderr.write(`${drawn > 1 ? `\x1B[${drawn - 1}A` : ''}\r\x1B[0J${frame.join('\n')}`)
    drawn = frame.length
  }

  try {
    stdin.setRawMode(true)
    stdin.resume()
    stderr.write('\x1B[?25l')
    draw('asking')

    return await new Promise<boolean>((resolve) => {
      const onData = (data: Buffer) => {
        for (const key of readKeys(data.toString())) {
          outcome = press(key)

          if (outcome !== undefined) {
            stdin.off('data', onData)
            resolve(outcome === 'enter')

            return
          }
        }

        draw('asking')
      }

      stdin.on('data', onData)
    })
  }
  finally {
    draw(outcome ?? 'cancel')
    stderr.write('\n\x1B[?25h')
    stdin.setRawMode(false)
    stdin.pause()
  }
}
