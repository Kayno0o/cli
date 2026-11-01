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
  write: (text: string) => unknown
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
// What the console prints with, to the terminal the line is drawn on or the other.
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'dirxml', 'table', 'trace', 'group', 'groupCollapsed', 'count', 'timeEnd', 'timeLog', 'assert'] as const

// A piece of the line and how it is tinted, so the line can be cut to the terminal's width on its visible text.
interface Part { text: string, tint: (colors: Colors) => (text: string) => string }

// One line on `stream`, redrawn in place while a task runs: a spinner, the step, a bar where its total is known, and the time since the step began.
// Drawn only on a terminal that takes control codes, so a log, CI or `NO_COLOR` gets `done` and `failed` lines alone; whatever else is printed meanwhile clears the line first, and the next frame draws it again under it.
export function progressLine(stream: ProgressStream = process.stderr, env: Env = process.env): ProgressLine {
  if (!takesControlCodes(stream, env)) {
    const begun = performance.now()

    return {
      update: () => undefined,
      stop: () => undefined,
      done: text => stream.write(`${marked('ok', text, stream, formatDuration(performance.now() - begun), env)}\n`),
      failed: text => stream.write(`${marked('problem', text, stream, undefined, env)}\n`),
    }
  }

  const colors = paint(stream, env)
  // Its own write, taken before the line clears itself ahead of every other.
  const write = stream.write.bind(stream)
  const begun = performance.now()
  let started = begun
  let current: Progress | undefined
  let frame = 0
  let drawn = false
  const clear = () => {
    if (drawn)
      write(CLEAR_LINE)

    drawn = false
  }
  const draw = () => {
    if (current === undefined)
      return

    // A terminal that does not say its width, as a pseudo-terminal may, answers 0.
    const width = (stream.columns === undefined || stream.columns === 0 ? 80 : stream.columns) - 1

    write(`${CLEAR_LINE}${fit(progressParts(current, FRAMES[frame++ % FRAMES.length]!, performance.now() - started), width, colors)}`)
    drawn = true
  }
  const timer = setInterval(draw, FRAME_MS)
  const restore = interceptOutput(clear)
  const onExit = () => clear()
  // Interrupted, the line goes before the shell's prompt comes back.
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
    // A new step is drawn at once, its clock started again; a count moving on waits for the next frame, so a burst of updates writes one.
    update: (progress) => {
      const step = current?.step

      current = progress

      if (progress.step !== step) {
        started = performance.now()
        draw()
      }
    },
    stop,
    done: (text) => {
      stop()
      write(`${marked('ok', text, stream, formatDuration(performance.now() - begun), env)}\n`)
    },
    failed: (text) => {
      stop()
      write(`${marked('problem', text, stream, undefined, env)}\n`)
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

// The parts cut to `width` visible characters, each tinted after the cut so no escape is split.
function fit(parts: Part[], width: number, colors: Colors): string {
  let room = width
  let line = ''

  for (const { text, tint } of parts) {
    const kept = [...text].slice(0, Math.max(room, 0)).join('')

    room -= kept.length

    if (kept !== '')
      line += tint(colors)(kept)
  }

  return line
}

// Clears the line before anything the console or a stream writes, the caller's own code meanwhile included, and answers how to put them back.
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
