import type { Height, Theme } from './view'
import { openSync } from 'node:fs'
import process from 'node:process'
import tty from 'node:tty'
import { fail, role } from '@kaynooo/cli-kit'
import { runPreview } from './preview'
import { chosen, createState, highlighted, parseKeys, press } from './state'
import { caretColumn, layoutFor, render } from './view'

export interface PickSettings {
  multi: boolean
  prompt: string
  query: string
  height: Height
  preview: string | undefined
}

const PREVIEW_DELAY_MS = 120
const HIDE_CURSOR = '\x1B[?25l'
const SHOW_CURSOR = '\x1B[?25h'
const CLEAR_BELOW = '\r\x1B[J'
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

function themeFor(stream: { isTTY?: boolean }): Theme {
  return { accent: role('accent', stream), label: role('label', stream), value: role('value', stream), id: role('id', stream) }
}

function up(lines: number): string {
  return lines > 0 ? `\x1B[${lines}A` : ''
}

/**
 * Lets the user pick among `lines`: keys come from /dev/tty in raw mode and the picker is drawn in place on stderr, so stdout stays free for the choice.
 * Resolves to the chosen lines, or undefined when cancelled; the terminal is restored whichever way it ends.
 */
export async function choose(lines: readonly string[], settings: PickSettings): Promise<string[] | undefined> {
  let input: tty.ReadStream

  try {
    input = new tty.ReadStream(openSync('/dev/tty', 'r'))
  }
  catch {
    return fail('no terminal to read keys from (/dev/tty)')
  }

  const out = process.stderr
  const theme = themeFor(out)
  let state = createState(lines, settings)
  let preview: string[] = []
  let reserved = 0
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  let previewing = new AbortController()
  let shownLine: number | undefined
  let finish: (() => void) | undefined
  let restored = false

  function draw(clear = false): void {
    const layout = layoutFor({ columns: out.columns || 80, rows: out.rows || 24 }, settings.height, settings.preview !== undefined)
    let frame = HIDE_CURSOR

    if (reserved !== layout.height || clear) {
      frame += CLEAR_BELOW + '\n'.repeat(layout.height - 1) + up(layout.height - 1)
      reserved = layout.height
    }

    frame += `\r${render(state, layout, theme, preview).map(line => `\x1B[2K${line}`).join('\n')}${up(layout.height - 1)}\r\x1B[${caretColumn(state, layout)}G${SHOW_CURSOR}`
    out.write(frame)
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
    const line = state.lines[at]!

    async function show(): Promise<void> {
      const shown = await runPreview(template, line, signal)

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
    out.write(`${CLEAR_BELOW}${SHOW_CURSOR}`)
    out.off('resize', onResize)

    try {
      input.setRawMode(false)
    }
    finally {
      input.destroy()
    }
  }

  function onResize(): void {
    draw(true)
  }

  function onData(chunk: Buffer | string): void {
    for (const key of parseKeys(chunk.toString())) {
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
    input.setRawMode(true)
    out.on('resize', onResize)
    input.on('data', onData)
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

  return state.done === 'accept' ? chosen(state) : undefined
}
