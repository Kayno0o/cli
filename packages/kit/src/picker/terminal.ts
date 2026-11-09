import type { Key, Row } from './state'
import type { Height, PreviewPosition, Theme } from './view'
import { openSync } from 'node:fs'
import process from 'node:process'
import tty from 'node:tty'
import { fail } from '../args'
import { stopJob } from '../job'
import { overwrite, SYNC_END, SYNC_START } from '../redraw'
import { paint, role } from '../style'
import { previewLines, runPreview } from './preview'
import { chosen, createState, highlighted, parseKeys, press, withRows } from './state'
import { caretCell, layoutFor, render } from './view'

/** What the preview shows for the highlighted row, from its hidden fields; `signal` aborts when another row is highlighted. */
export type PreviewFn = (hidden: string[], signal: AbortSignal) => string | Promise<string>

export interface Reloaded {
  /** Replaces the header, which stays when left out. */
  header?: string
  rows: Row[]
}

/** Replaces the rows, and the header if given, in place and with the query kept: when `key` is pressed, and once the picker is open if `onOpen`. */
export interface Reload {
  key?: string
  onOpen?: boolean
  run: () => Reloaded | Promise<Reloaded>
}

export interface PickSettings {
  multi: boolean
  prompt: string
  query: string
  height: Height
  /** A shell command, where `{1}`, `{2}`... stand for the hidden fields and `{}` for the row, or a function. */
  preview: string | PreviewFn | undefined
  previewPosition?: PreviewPosition | undefined
  reload?: Reload | undefined
  header?: string | undefined
  /** Control keys that end the pick, named as `ctrl-d`. */
  expect?: readonly string[] | undefined
  /** How many leading cells are searched, all of them by default. */
  searched?: number | undefined
}

export interface Selection {
  rows: Row[]
  /** The expected key that ended the pick, empty for enter. */
  key: string
  query: string
}

/** The keyboard and the screen the picker works on, which tests replace. */
export interface Terminal {
  columns: number
  rows: number
  theme: Theme
  write: (text: string) => void
  /** Starts reading raw input, calling back with each chunk of it and when the screen is resized. */
  listen: (onChunk: (chunk: string) => void, onResize: () => void) => void
  /** Gives the terminal back and stops the process, as ctrl-z does outside raw mode, returning once the shell resumes it. */
  suspend?: () => void
  close: () => void
}

const PREVIEW_DELAY_MS = 120
const ESCAPE_WAIT_MS = 30
// What a reload on open is queued as, having no key of its own.
const OPEN: Key = { ctrl: 'open' }
const HIDE_CURSOR = '\x1B[?25l'
const SHOW_CURSOR = '\x1B[?25h'
// The caret is the cell under it drawn reversed.
const REVERSE = '\x1B[7m'
const REVERSE_END = '\x1B[27m'
const PASTE_ON = '\x1B[?2004h'
const PASTE_OFF = '\x1B[?2004l'
// Report the wheel, in the SGR form that carries any column.
const MOUSE_ON = '\x1B[?1000h\x1B[?1006h'
const MOUSE_OFF = '\x1B[?1006l\x1B[?1000l'
const CLEAR_BELOW = '\r\x1B[J'
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

function up(lines: number): string {
  return lines > 0 ? `\x1B[${lines}A` : ''
}

/** The keyboard from /dev/tty in raw mode and the screen on stderr, so stdout stays free for the choice. */
export function openTerminal(): Terminal {
  let mode: tty.ReadStream

  try {
    mode = new tty.ReadStream(openSync('/dev/tty', 'r'))
  }
  catch {
    return fail('no terminal to read keys from (/dev/tty)')
  }

  // Bun's tty.ReadStream left a read pending once destroyed outside its data callback, holding the process until one more key that it swallowed (oven-sh/bun#47964), so it only switches raw mode and the keys come from a reader cancel() stops.
  const keys = Bun.file('/dev/tty').stream().getReader()
  const out = process.stderr
  let resize: (() => void) | undefined

  // A terminal that stops answering cancels the pick, as ctrl-c would.
  async function read(onChunk: (chunk: string) => void): Promise<void> {
    const decoder = new TextDecoder()

    try {
      for (let chunk = await keys.read(); !chunk.done; chunk = await keys.read())
        onChunk(decoder.decode(chunk.value, { stream: true }))
    }
    catch {
      onChunk('\x03')
    }
  }

  return {
    get columns() {
      return out.columns || 80
    },
    get rows() {
      return out.rows || 24
    },
    theme: { accent: role('accent', out), label: role('label', out), value: role('value', out), id: role('id', out), match: text => paint(out).underline(role('accent', out)(text)) },
    write: text => void out.write(text),
    listen(onChunk, onResize) {
      resize = onResize
      mode.setRawMode(true)
      out.on('resize', onResize)
      void read(onChunk)
    },
    suspend() {
      mode.setRawMode(false)
      stopJob()
      mode.setRawMode(true)
    },
    close() {
      if (resize !== undefined)
        out.off('resize', resize)

      try {
        mode.setRawMode(false)
      }
      finally {
        mode.destroy()
        void keys.cancel()
      }
    },
  }
}

/**
 * Lets the user pick among `rows`: the picker is drawn in place on the terminal's screen and its keys read from the terminal.
 * Resolves to the chosen rows, the expected key that ended the pick and the query, or undefined when cancelled; the terminal is restored whichever way it ends.
 */
export async function select(rows: readonly Row[], settings: PickSettings, terminal: Terminal = openTerminal()): Promise<Selection | undefined> {
  const { theme } = terminal
  let state = createState(rows, settings)
  let preview: string[] = []
  let reserved = 0
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  let previewing = new AbortController()
  let shownLine: number | undefined
  let finish: (() => void) | undefined
  let restored = false
  // A lone escape may be the start of a sequence the terminal sends in two reads, such as an Alt-key, so it waits a moment for the rest before it cancels.
  let escape: ReturnType<typeof setTimeout> | undefined

  function draw(clear = false): void {
    if (restored)
      return

    const layout = layoutFor({ columns: terminal.columns, rows: terminal.rows }, settings.height, settings.preview !== undefined, settings.previewPosition)
    let frame = SYNC_START + HIDE_CURSOR

    // The terminal's cursor stays hidden at the start of the first line, where a terminal rewrapping the frame as it narrows cannot move it off that row, so one erase from there takes the frame whatever rows it spans; the caret is drawn as a reversed cell instead.
    if (reserved !== layout.height || clear) {
      frame += CLEAR_BELOW + '\n'.repeat(layout.height - 1) + up(layout.height - 1)
      reserved = layout.height
    }

    const caret = caretCell(state, layout)

    frame += `\r${overwrite(render(state, layout, theme, preview), terminal.columns)}${up(layout.height - 1)}\r\x1B[${caret.column}G${REVERSE}${caret.char}${REVERSE_END}\r${SYNC_END}`
    terminal.write(frame)
  }

  // The list rows on screen, less the prompt, the counts and the header lines.
  function pageSize(): number {
    const headerLines = state.header === '' ? 0 : state.header.split('\n').length

    return Math.max(1, layoutFor({ columns: terminal.columns, rows: terminal.rows }, settings.height, settings.preview !== undefined, settings.previewPosition).listHeight - 2 - headerLines)
  }

  function refreshPreview(): void {
    const at = highlighted(state)

    if (settings.preview === undefined || at === shownLine)
      return

    shownLine = at
    clearTimeout(previewTimer)
    previewing.abort()
    previewing = new AbortController()

    if (at === undefined) {
      preview = []

      return
    }

    const { signal } = previewing
    const template = settings.preview
    const row = state.rows[at]!

    async function show(): Promise<void> {
      const shown = typeof template === 'string' ? await runPreview(template, row.cells.join(' '), signal, row.hidden) : await previewOf(template, row.hidden, signal)

      if (!signal.aborted) {
        preview = shown
        draw()
      }
    }

    previewTimer = setTimeout(() => void show(), PREVIEW_DELAY_MS)
  }

  function restore(): void {
    if (restored)
      return

    restored = true
    clearTimeout(previewTimer)
    clearTimeout(escape)
    previewing.abort()
    terminal.write(`${CLEAR_BELOW}${MOUSE_OFF}${PASTE_OFF}${SHOW_CURSOR}`)
    terminal.close()
  }

  // The frame goes while the shell has the terminal, and comes back whole once it is resumed.
  function suspend(): void {
    if (terminal.suspend === undefined)
      return

    terminal.write(`${CLEAR_BELOW}${MOUSE_OFF}${PASTE_OFF}${SHOW_CURSOR}`)
    terminal.suspend()
    terminal.write(`${PASTE_ON}${MOUSE_ON}`)
    draw(true)
  }

  const stop = (): void => {
    state = { ...state, done: 'cancel' }
    finish?.()
  }

  const paste = { active: false }
  const { reload } = settings
  const pending: Key[] = []
  let busy = false
  let draining = false

  async function reloadRows(): Promise<void> {
    if (reload === undefined)
      return

    busy = true
    state = { ...state, status: 'reloading' }
    draw()

    try {
      const next = await reload.run()

      state = { ...withRows(state, next.rows, next.header), status: '' }
      shownLine = undefined
    }
    catch (error) {
      state = { ...state, status: `reload failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    finally {
      busy = false
    }
  }

  // Keys are taken one at a time, those typed during a reload waiting for it.
  async function drain(): Promise<void> {
    if (draining)
      return

    draining = true

    try {
      for (let key = pending.shift(); key !== undefined && state.done === undefined; key = pending.shift()) {
        if (key === OPEN || (typeof key === 'object' && 'ctrl' in key && key.ctrl === reload?.key))
          await reloadRows()
        else if (key === 'suspend')
          suspend()
        else
          state = press({ ...state, page: pageSize() }, key)
      }
    }
    finally {
      draining = false
    }

    if (state.done !== undefined) {
      finish?.()

      return
    }

    refreshPreview()
    draw()
  }

  function onChunk(chunk: string): void {
    if (escape !== undefined) {
      clearTimeout(escape)
      escape = undefined
      chunk = `\x1B${chunk}`
    }
    else if (chunk === '\x1B') {
      escape = setTimeout(() => {
        escape = undefined
        takeKeys('\x1B')
      }, ESCAPE_WAIT_MS)

      return
    }

    takeKeys(chunk)
  }

  function takeKeys(chunk: string): void {
    const keys = parseKeys(chunk, paste, [...settings.expect ?? [], ...reload?.key === undefined ? [] : [reload.key]])

    if (busy && keys.includes('cancel')) {
      stop()

      return
    }

    pending.push(...keys)
    void drain()
  }

  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })

  process.once('exit', restore)

  for (const signal of SIGNALS)
    process.once(signal, stop)

  try {
    terminal.write(`${PASTE_ON}${MOUSE_ON}`)
    terminal.listen(onChunk, () => draw(true))
    refreshPreview()
    draw(true)

    if (reload?.onOpen === true) {
      pending.push(OPEN)
      void drain()
    }

    await ended
  }
  finally {
    for (const signal of SIGNALS)
      process.off(signal, stop)

    process.off('exit', restore)
    restore()
  }

  return state.done === 'accept' ? { rows: chosen(state), key: state.key, query: state.query } : undefined
}

async function previewOf(preview: PreviewFn, hidden: string[], signal: AbortSignal): Promise<string[]> {
  try {
    return previewLines(await preview(hidden, signal))
  }
  catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
}

/** `select` over plain lines, resolving to the chosen ones. */
export async function choose(lines: readonly string[], settings: PickSettings): Promise<string[] | undefined> {
  const picked = await select(lines.map(line => ({ hidden: [], cells: [line] })), settings)

  return picked?.rows.map(row => row.cells[0]!)
}
