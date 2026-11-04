import type { Row } from './state'
import type { Height, Theme } from './view'
import { openSync } from 'node:fs'
import process from 'node:process'
import tty from 'node:tty'
import { fail } from '../args'
import { role } from '../style'
import { runPreview } from './preview'
import { chosen, createState, highlighted, parseKeys, press } from './state'
import { caretColumn, layoutFor, render } from './view'

export interface PickSettings {
  multi: boolean
  prompt: string
  query: string
  height: Height
  preview: string | undefined
  header?: string
  /** Control keys that end the pick, named as `ctrl-d`. */
  expect?: readonly string[]
  /** How many leading cells are searched, all of them by default. */
  searched?: number
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
  close: () => void
}

const PREVIEW_DELAY_MS = 120
const HIDE_CURSOR = '\x1B[?25l'
const SHOW_CURSOR = '\x1B[?25h'
const PASTE_ON = '\x1B[?2004h'
const PASTE_OFF = '\x1B[?2004l'
const CLEAR_BELOW = '\r\x1B[J'
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

function up(lines: number): string {
  return lines > 0 ? `\x1B[${lines}A` : ''
}

/** The keyboard from /dev/tty in raw mode and the screen on stderr, so stdout stays free for the choice. */
export function openTerminal(): Terminal {
  let input: tty.ReadStream

  try {
    input = new tty.ReadStream(openSync('/dev/tty', 'r'))
  }
  catch {
    return fail('no terminal to read keys from (/dev/tty)')
  }

  const out = process.stderr
  let resize: (() => void) | undefined

  return {
    get columns() {
      return out.columns || 80
    },
    get rows() {
      return out.rows || 24
    },
    theme: { accent: role('accent', out), label: role('label', out), value: role('value', out), id: role('id', out) },
    write: text => void out.write(text),
    listen(onChunk, onResize) {
      resize = onResize
      input.setRawMode(true)
      out.on('resize', onResize)
      input.on('data', chunk => onChunk(chunk.toString()))
    },
    close() {
      if (resize !== undefined)
        out.off('resize', resize)

      try {
        input.setRawMode(false)
      }
      finally {
        input.destroy()
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

  function draw(clear = false): void {
    if (restored)
      return

    const layout = layoutFor({ columns: terminal.columns, rows: terminal.rows }, settings.height, settings.preview !== undefined)
    let frame = HIDE_CURSOR

    if (reserved !== layout.height || clear) {
      frame += CLEAR_BELOW + '\n'.repeat(layout.height - 1) + up(layout.height - 1)
      reserved = layout.height
    }

    frame += `\r${render(state, layout, theme, preview).map(line => `\x1B[2K${line}`).join('\n')}${up(layout.height - 1)}\r\x1B[${caretColumn(state, layout)}G${SHOW_CURSOR}`
    terminal.write(frame)
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
      const shown = await runPreview(template, row.cells.join(' '), signal, row.hidden)

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
    previewing.abort()
    terminal.write(`${CLEAR_BELOW}${PASTE_OFF}${SHOW_CURSOR}`)
    terminal.close()
  }

  const paste = { active: false }

  function onChunk(chunk: string): void {
    for (const key of parseKeys(chunk, paste, settings.expect)) {
      state = press(state, key)

      if (state.done !== undefined) {
        finish?.()

        return
      }
    }

    refreshPreview()
    draw()
  }

  const stop = (): void => {
    state = { ...state, done: 'cancel' }
    finish?.()
  }

  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })

  process.once('exit', restore)

  for (const signal of SIGNALS)
    process.once(signal, stop)

  try {
    terminal.write(PASTE_ON)
    terminal.listen(onChunk, () => draw(true))
    refreshPreview()
    draw(true)
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

/** `select` over plain lines, resolving to the chosen ones. */
export async function choose(lines: readonly string[], settings: PickSettings): Promise<string[] | undefined> {
  const picked = await select(lines.map(line => ({ hidden: [], cells: [line] })), settings)

  return picked?.rows.map(row => row.cells[0]!)
}
