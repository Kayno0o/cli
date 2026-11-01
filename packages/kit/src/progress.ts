import type { Colors } from './style'
import process from 'node:process'
import { formatDuration } from './format'
import { holdSignals } from './process'
import { marked, paint, takesControlCodes } from './style'

export interface Progress {
  step: string
  done?: number | undefined
  total?: number | undefined
  unit?: string | undefined
}

interface ProgressStream {
  isTTY?: boolean
  columns?: number | undefined
  rows?: number | undefined
  write: (text: string) => unknown
}

export interface LiveRegion {
  // Draws the lines again now, rather than at the next frame.
  redraw: () => void
  // Prints `text` above the region, where it stays once the region goes.
  print: (text: string) => void
  // Clears the region and leaves nothing behind.
  stop: () => void
}

export interface TaskHandle {
  update: (progress: Omit<Progress, 'step'>) => void
  // Leaves `✓ <text> <time since the task began>` above the tasks still running, the label when no text is given.
  done: (text?: string) => void
  // Leaves `✗ <text>`, the label when no text is given.
  failed: (text?: string) => void
}

export interface TaskList {
  add: (label: string) => TaskHandle
}

export interface ProgressLine {
  update: (progress: Progress) => void
  // Clears the line and leaves nothing behind.
  stop: () => void
  // Clears the line and leaves `✓ <text> <time since the line began>` in its place.
  done: (text: string) => void
  // Clears the line and leaves `✗ <text>` in its place.
  failed: (text: string) => void
}

type Env = Record<string, string | undefined>

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 80
const BAR_WIDTH = 20
// Back to the start of the line, then erases it.
const CLEAR_LINE = '\r\x1B[2K'
// Up a line, then erases it.
const LINE_UP = '\x1B[1A\x1B[2K'
const ESC = String.fromCharCode(27)
// A colour or cursor code, or an OSC 8 link's opening or closing, read where `lastIndex` points.
const ESCAPE_CODE = new RegExp(`${ESC}(?:\\[[\\x30-\\x3F]*[\\x20-\\x2F]*[\\x40-\\x7E]|\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\))`, 'y')
const RESET_STYLE = `${ESC}[0m`
const CLOSE_LINK = `${ESC}]8;;${ESC}\\`
// What the console prints with, to the terminal the line is drawn on or the other.
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'dirxml', 'table', 'trace', 'group', 'groupCollapsed', 'count', 'timeEnd', 'timeLog', 'assert'] as const

// A piece of the line and how it is tinted, so the line can be cut to the terminal's width on its visible text.
interface Part { text: string, tint: (colors: Colors) => (text: string) => string }

// Lines on `stream` redrawn in place every frame, `render` handed the spinner's next glyph, each line cut to the terminal's width and the block to its height.
// Drawn only on a terminal that takes control codes, so elsewhere `render` never runs and the caller prints its own outcome; whatever else is printed meanwhile clears the block first, the next frame drawing it again under it, and an interrupt clears it before the process ends.
export function liveRegion(render: (spinner: string) => string[], stream: ProgressStream = process.stderr, env: Env = process.env): LiveRegion {
  if (!takesControlCodes(stream, env))
    return { redraw: () => undefined, print: text => void stream.write(`${text}\n`), stop: () => undefined }

  // Its own write, taken before the region clears itself ahead of every other.
  const write = stream.write.bind(stream)
  let frame = 0
  let drawn = 0
  const clear = () => {
    if (drawn > 0)
      write(`${CLEAR_LINE}${LINE_UP.repeat(drawn - 1)}`)

    drawn = 0
  }
  const draw = () => {
    // A terminal that does not say its size, as a pseudo-terminal may, answers 0.
    const width = (stream.columns === undefined || stream.columns === 0 ? 80 : stream.columns) - 1
    const height = stream.rows === undefined || stream.rows === 0 ? 24 : stream.rows
    const lines = render(FRAMES[frame++ % FRAMES.length]!).slice(0, Math.max(1, height - 1)).map(line => cutToWidth(line, width))

    if (lines.length === 0) {
      clear()

      return
    }

    write(`${drawn > 0 ? `${CLEAR_LINE}${LINE_UP.repeat(drawn - 1)}` : CLEAR_LINE}${lines.join('\n')}`)
    drawn = lines.length
  }
  const timer = setInterval(draw, FRAME_MS)
  const restore = interceptOutput(clear)
  const onExit = () => clear()
  // Interrupted, the block goes before the shell's prompt comes back.
  const signals = holdSignals(stop)

  function stop() {
    clearInterval(timer)
    clear()
    restore()
    process.off('exit', onExit)
    signals.release()
  }

  timer.unref()
  process.on('exit', onExit)

  return {
    redraw: draw,
    print: (text) => {
      clear()
      write(`${text}\n`)
      draw()
    },
    stop,
  }
}

// One line on `stream`, redrawn in place while a task runs: a spinner, the step, a bar where its total is known, and the time since the step began.
// Off a terminal taking control codes, a log, CI or `NO_COLOR` gets the `done` and `failed` lines alone.
export function progressLine(stream: ProgressStream = process.stderr, env: Env = process.env): ProgressLine {
  const colors = paint(stream, env)
  // Its own write, taken before the region clears itself ahead of every other.
  const write = stream.write.bind(stream)
  const begun = performance.now()
  let started = begun
  let current: Progress | undefined
  const region = liveRegion(spinner => current === undefined ? [] : [tinted(progressParts(current, spinner, performance.now() - started), colors)], stream, env)
  const end = (line: string) => {
    region.stop()
    write(`${line}\n`)
  }

  return {
    // A new step is drawn at once, its clock started again; a count moving on waits for the next frame, so a burst of updates writes one.
    update: (progress) => {
      const step = current?.step

      current = progress

      if (progress.step !== step) {
        started = performance.now()
        region.redraw()
      }
    },
    stop: region.stop,
    done: text => end(marked('ok', text, stream, formatDuration(performance.now() - begun), env)),
    failed: text => end(marked('problem', text, stream, undefined, env)),
  }
}

// Stacked lines for tasks running side by side, each drawn as a progress line is; a task ending leaves its ✓ or ✗ line above those still running, and the block goes once none is.
export function taskList(stream: ProgressStream = process.stderr, env: Env = process.env): TaskList {
  const colors = paint(stream, env)
  const running = new Set<{ progress: Progress, started: number }>()
  let region: LiveRegion | undefined
  const render = (spinner: string) => [...running].map(({ progress, started }) => tinted(progressParts(progress, spinner, performance.now() - started), colors))

  return {
    add: (label) => {
      const entry = { progress: { step: label } as Progress, started: performance.now() }
      const end = (line: string) => {
        if (!running.delete(entry))
          return

        region?.print(line)

        if (running.size === 0) {
          region?.stop()
          region = undefined
        }
      }

      running.add(entry)
      region ??= liveRegion(render, stream, env)
      region.redraw()

      return {
        update: (progress) => {
          entry.progress = { ...progress, step: label }
        },
        done: text => end(marked('ok', text ?? label, stream, formatDuration(performance.now() - entry.started), env)),
        failed: text => end(marked('problem', text ?? label, stream, undefined, env)),
      }
    },
  }
}

// Runs one step under a spinner on a terminal, then leaves `✓ <label> <time>`, or `✗ <label>` and throws again; off a terminal those lines alone print, as `ok:` and `error:`.
export async function task<T>(label: string, run: (update: (progress: Omit<Progress, 'step'>) => void) => Promise<T>, stream: ProgressStream = process.stderr, env: Env = process.env): Promise<T> {
  const line = progressLine(stream, env)

  line.update({ step: label })

  try {
    const result = await run(progress => line.update({ ...progress, step: label }))

    line.done(label)

    return result
  }
  catch (error) {
    line.failed(label)

    throw error
  }
}

// `⠹ prerendering ████████░░░░░░░░░░░░ 8/20 routes 4.2s`; a step with no total has no bar.
export function progressText(progress: Progress, spinner: string, ms: number): string {
  return progressParts(progress, spinner, ms).map(part => part.text).join('')
}

function progressParts({ step, done, total, unit }: Progress, spinner: string, ms: number): Part[] {
  const parts: Part[] = [{ text: spinner, tint: colors => colors.cyan }, { text: ` ${step}`, tint: () => plain }]

  if (total !== undefined && total > 0) {
    const counted = Math.min(done ?? 0, total)
    const filled = Math.round(counted / total * BAR_WIDTH)

    parts.push(
      { text: ' ', tint: () => plain },
      { text: '█'.repeat(filled), tint: colors => colors.cyan },
      { text: '░'.repeat(BAR_WIDTH - filled), tint: colors => colors.dim },
      { text: ` ${counted}/${total}${unit === undefined ? '' : ` ${unit}`}`, tint: colors => colors.dim },
    )
  }

  parts.push({ text: ` ${(ms / 1000).toFixed(1)}s`, tint: colors => colors.dim })

  return parts
}

function plain(text: string): string {
  return text
}

function tinted(parts: Part[], colors: Colors): string {
  return parts.map(({ text, tint }) => tint(colors)(text)).join('')
}

// The line cut to `width` columns of visible text, its escapes kept whole, and the styles and a link ended after a cut so none runs into the next line.
function cutToWidth(line: string, width: number): string {
  if (Bun.stringWidth(line) <= width)
    return line

  let room = width
  let kept = ''
  let index = 0
  let linked = false

  while (index < line.length) {
    ESCAPE_CODE.lastIndex = index

    const escape = ESCAPE_CODE.exec(line)

    if (escape !== null) {
      kept += escape[0]
      linked ||= escape[0].startsWith(`${ESC}]`)
      index = ESCAPE_CODE.lastIndex

      continue
    }

    const char = String.fromCodePoint(line.codePointAt(index)!)
    const columns = Bun.stringWidth(char)

    if (columns > room)
      break

    kept += char
    room -= columns
    index += char.length
  }

  return `${kept}${RESET_STYLE}${linked ? CLOSE_LINK : ''}`
}

// Clears the region before anything the console or a stream writes, the caller's own code meanwhile included, and answers how to put them back.
function interceptOutput(clear: () => void): () => void {
  const targets = [...CONSOLE_METHODS.map(name => [console, name] as const), [process.stdout, 'write'] as const, [process.stderr, 'write'] as const]
  const wrapped = targets.map(([target, name]) => {
    const original = Reflect.get(target, name) as (...args: unknown[]) => unknown
    const wrapper = (...args: unknown[]) => {
      clear()

      return original.apply(target, args)
    }

    Reflect.set(target, name, wrapper)

    return { target, name, original, wrapper }
  })

  // What the caller replaced meanwhile is its own, and stays.
  return () => {
    for (const { target, name, original, wrapper } of wrapped) {
      if (Reflect.get(target, name) === wrapper)
        Reflect.set(target, name, original)
    }
  }
}
