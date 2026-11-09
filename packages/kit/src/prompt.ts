import type { EditKey, Line } from './picker/line'
import type { Colors } from './style'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fail } from './args'
import { textWidth, truncate } from './format'
import { isInteractive } from './mode'
import { editLine, isEditKey, visible } from './picker/line'
import { parseKeys } from './picker/state'
import { overwrite, rowsTaken, SYNC_END, SYNC_START } from './redraw'
import { paint } from './style'

const WORDS = /\s+/
// Choices drawn at once at most, the rest scrolled to.
const MAX_ROWS = 10

type Key = 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end' | 'enter' | 'cancel' | EditKey | { text: string }
const PROMPT_KEYS: ReadonlySet<unknown> = new Set(['up', 'down', 'pageup', 'pagedown', 'home', 'end', 'enter', 'cancel'])

type Outcome = 'enter' | 'cancel'
type State = 'asking' | Outcome

export interface Choice<T> {
  value: T
  label: string
  hint: string
}

// The ends a prompt reads keys from and draws on, the process's own by default.
export interface Terminal {
  stdin: Pick<NodeJS.ReadStream, 'setRawMode' | 'resume' | 'pause' | 'on' | 'off'> & { isTTY?: boolean }
  stderr: Pick<NodeJS.WriteStream, 'write' | 'columns' | 'rows'> & { isTTY?: boolean, on?: NodeJS.WriteStream['on'], off?: NodeJS.WriteStream['off'] }
}

export interface PromptSettings {
  // Shown under the error a prompt fails with off a terminal, such as `pass --yes`.
  hint?: string
  terminal?: Terminal
}

// The keys a chunk of terminal input holds that prompts read, through the picker's parser: what it has for filtering and marking rows is left out.
function readKeys(input: string, paste = { active: false }): Key[] {
  return parseKeys(input, paste).filter((key): key is Key => typeof key === 'object' ? 'text' in key : PROMPT_KEYS.has(key) || isEditKey(key))
}

// The columns left after `? question ` on the row it ends on, wrapped when wider than the terminal, the last column kept free.
function roomAfter(question: string, columns: number): number {
  return Math.max(columns - textWidth(`? ${question} `) % columns - 1, 1)
}

// A line typed, cut around its caret to the room given, the caret drawn as the character under it reversed, or a dimmed block at the end.
function withCaret(colors: Colors, line: Line, room: number, dim = false): string {
  const { before, at, after } = visible(line, room)
  const tone = dim ? colors.dim : (text: string) => text

  return `${tone(before)}${at === undefined ? colors.dim('█') : colors.inverse(at)}${tone(after)}`
}

export interface SelectSettings<T> extends PromptSettings {
  // The index of the choice the cursor starts on.
  initial?: number
  // The value of the choice the cursor starts on, winning over `initial` when a choice holds it.
  default?: T
}

// One choice among several, typing filtering them, the arrows moving and Enter picking; undefined once Escape or Ctrl+C cancels.
export async function select<T>(question: string, choices: Choice<T>[], { initial = 0, default: fallback, ...settings }: SelectSettings<T> = {}): Promise<T | undefined> {
  const named = choices.findIndex(choice => choice.value === fallback)
  const list = new List(choices, fallback === undefined || named === -1 ? initial : named)
  const picked = await ask(question, settings, (colors, state, rows) => state === 'asking'
    ? [asking(colors, question, list.typed(colors, rows.columns, question), 'type to filter, enter picks'), ...list.rows(colors, rows, () => '')]
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
  // How many choices Enter needs checked: on fewer, `pick at least N` shows under the list until the next key instead of answering.
  min?: number
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
export async function checklist<T>(question: string, choices: Choice<T>[], { initial = new Set(), min = 0, toggle = flip, ...settings }: ChecklistSettings<T> = {}): Promise<ReadonlySet<T> | undefined> {
  const list = new List(choices, 0)
  let checked = initial
  let invalid: string | undefined
  const accepted = await ask(question, settings, (colors, state, rows) => state === 'asking'
    ? [asking(colors, question, list.typed(colors, rows.columns, question), 'type to filter, space toggles, enter accepts'), ...list.rows(colors, rows, choice => checked.has(choice.value) ? `${colors.cyan('◉')} ` : `${colors.dim('◯')} `), ...invalid === undefined ? [] : [`  ${colors.red(invalid)}`]]
    : [answer(colors, question, state, choices.filter(choice => checked.has(choice.value)).map(choice => choice.label).join(', ') || 'none')], (key) => {
    if (key === 'cancel')
      return key

    invalid = undefined

    if (key === 'enter') {
      invalid = checked.size < min ? `pick at least ${min}` : undefined

      return invalid === undefined ? 'enter' : undefined
    }

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
  let line: Line = { text: '', caret: 0 }
  let invalid: string | undefined
  const taken = () => line.text === '' ? fallback ?? '' : line.text
  const shown = () => mask ? '*'.repeat([...taken()].length) : taken()
  const accepted = await ask(question, settings, (colors, state, { columns }) => {
    if (state !== 'asking')
      return [answer(colors, question, state, shown())]

    // The default stands dimmed until something is typed, the caret after it.
    const typed = line.text === '' ? { text: shown(), caret: [...shown()].length } : { text: shown(), caret: line.caret }

    return [`${colors.cyan('?')} ${question} ${withCaret(colors, typed, roomAfter(question, columns), line.text === '')}`, ...invalid === undefined ? [] : [`  ${colors.red(invalid)}`]]
  }, (key) => {
    if (key === 'cancel')
      return 'cancel'

    invalid = undefined

    if (key === 'enter') {
      invalid = validate?.(taken())

      return invalid === undefined ? 'enter' : undefined
    }

    // Home and End move the caret here, as there is no list for them to move in.
    const edit = { home: 'linestart', end: 'lineend' }[key as string] ?? key

    if (typeof edit === 'object' || isEditKey(edit))
      line = editLine(line, edit)

    return undefined
  })

  return accepted ? taken() : undefined
}

// The choices a filter leaves, the cursor on one of them and the window of rows drawn around it.
class List<T> {
  private line: Line = { text: '', caret: 0 }
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

    // Home, End and the pages stop at the ends instead of wrapping round as the arrows do.
    if (key === 'home' || key === 'end' || key === 'pageup' || key === 'pagedown') {
      const last = this.matches.length - 1
      const to = { home: 0, end: last, pageup: this.cursor - MAX_ROWS, pagedown: this.cursor + MAX_ROWS }[key]

      this.cursor = Math.max(0, Math.min(last, to))

      return
    }

    if (typeof key !== 'object' && !isEditKey(key))
      return

    const edited = editLine(this.line, key)

    if (edited.text !== this.line.text)
      this.filter(edited.text)

    this.line = edited
  }

  // The filter as typed after the question, with its caret; empty while nothing is typed.
  typed(colors: Colors, columns: number, question: string): string {
    return this.line.text === '' ? '' : withCaret(colors, this.line, roomAfter(question, columns))
  }

  // Every word typed is in the label or the hint, case ignored; the cursor stays on its choice while it still matches, else goes to the first.
  private filter(query: string): void {
    const words = query.toLowerCase().split(WORDS).filter(word => word !== '')
    const current = this.current()

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

  if (!isInteractive(terminal))
    fail(`cannot ask "${question}" off a terminal`, 2, hint)

  const colors = paint(stderr)
  let current: State = 'asking'
  let outcome: Outcome | undefined
  // A terminal that does not say its size, as a pseudo-terminal may, answers 0.
  const columns = () => stderr.columns || 80
  // The cursor rests at the start of the first line, so a terminal that rewraps the frame as it narrows cannot move it off that row; the last frame ends on its last line instead.
  // What lies below the frame's last line is erased after it, for a frame shorter than the one before. A line wider than the terminal wraps, so the cursor climbs back the rows the frame takes, not its lines.
  const draw = (state: State, last = false) => {
    const frame = render(colors, state, { columns: columns(), rows: stderr.rows || 24 })
    const rows = rowsTaken(frame, columns())

    stderr.write(`${SYNC_START}\r${overwrite(frame, columns())}\x1B[0J${last || rows < 2 ? '' : `\x1B[${rows - 1}A`}${last ? '' : '\r'}${SYNC_END}`)
    current = state
  }
  const redraw = () => draw(current)
  const paste = { active: false }

  try {
    stderr.on?.('resize', redraw)
    stdin.setRawMode(true)
    stdin.resume()
    stderr.write('\x1B[?25l\x1B[?2004h')
    draw('asking')

    return await new Promise<boolean>((resolve) => {
      function onData(data: Buffer) {
        for (const key of readKeys(data.toString(), paste)) {
          const pressed = press(key)

          if (pressed !== undefined) {
            settle(pressed)

            return
          }
        }

        draw('asking')
      }

      // A stdin closing before an answer, as a terminal hung up does, cancels instead of leaving the prompt waiting forever.
      function onEnd() {
        settle('cancel')
      }

      function settle(settled: Outcome) {
        outcome = settled
        stdin.off('data', onData)
        stdin.off('end', onEnd)
        resolve(settled === 'enter')
      }

      stdin.on('data', onData)
      stdin.on('end', onEnd)
    })
  }
  finally {
    stderr.off?.('resize', redraw)
    draw(outcome ?? 'cancel', true)
    stderr.write('\n\x1B[?25h\x1B[?2004l')
    stdin.setRawMode(false)
    stdin.pause()
  }
}

export interface EditorSettings extends PromptSettings {
  // The text the file starts with.
  default?: string
  // The file's extension, such as `.md`, so the editor picks its highlighting.
  extension?: string
  // Where VISUAL and EDITOR are read, the process's environment by default.
  env?: Record<string, string | undefined>
}

// A text edited in VISUAL or EDITOR (vi without either) on a temp file, the editor taking the terminal until it exits; undefined when it exits nonzero, as `:cq` does.
export async function editor(question: string, { default: text = '', extension = '.txt', env = process.env, hint, terminal = process }: EditorSettings = {}): Promise<string | undefined> {
  const { stderr } = terminal

  if (!isInteractive(terminal))
    fail(`cannot ask "${question}" off a terminal`, 2, hint)

  const colors = paint(stderr)
  const command = [env.VISUAL, env.EDITOR].find(value => value !== undefined && value !== '') ?? 'vi'
  const dir = await mkdtemp(join(tmpdir(), 'kit-editor-'))
  const file = join(dir, `edit${extension}`)

  try {
    await writeFile(file, text)
    stderr.write(`${colors.cyan('?')} ${question} ${colors.dim(`(${command})`)}\n`)

    // Through the shell, so an EDITOR with arguments (`code --wait`) runs as typed.
    const edited = Bun.spawn(['sh', '-c', `${command} "$1"`, 'sh', file], { stdio: ['inherit', 'inherit', 'inherit'], env })
    const done = await edited.exited === 0

    stderr.write(`${answer(colors, question, done ? 'enter' : 'cancel', 'edited')}\n`)

    return done ? await readFile(file, 'utf8') : undefined
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}
