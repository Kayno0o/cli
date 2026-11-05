import { constants } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'

export interface Chunk {
  stream: 'stdout' | 'stderr'
  data: Uint8Array
}

export interface Ran {
  code: number
  // Both streams in the order they arrived.
  chunks: Chunk[]
  // The bytes of every chunk joined.
  output: Buffer
  text: string
  // The command was ended because `timeoutMs` passed, its code then being the signal's.
  timedOut: boolean
  // More than `maxBytes` came, and the rest was left out of chunks, output and text.
  truncated: boolean
}

export interface RunSettings {
  cwd?: string
  env?: Record<string, string | undefined>
  stdin?: 'inherit' | 'ignore'
  // Ends the command and its children after this long.
  timeoutMs?: number
  // Ends the command and its children when aborted.
  signal?: AbortSignal
  // Bytes kept in the result; the pipes are still read to the end.
  maxBytes?: number
  // Called with each chunk as it arrives; throwing ends the command and rethrows once the pipes are drained.
  onChunk?: (chunk: Chunk) => void
  // Called once the command runs, with a handle that sends a signal to its whole process group, for `holdSignals().forward`.
  onStart?: (child: { kill: (signal: NodeJS.Signals) => void }) => void
}

export interface HeldSignals {
  // The last signal received, undefined while none has come.
  readonly signal: NodeJS.Signals | undefined
  // Passes each signal received from now on to `child`, so it ends and its code is the one to exit with.
  forward: (child: { kill: (signal: NodeJS.Signals) => unknown }) => void
  // Takes the handlers off again, and may be called more than once.
  release: () => void
}

const KILL_GRACE_MS = 2000
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
// A scheme of two letters or more, so a Windows drive is read as a path.
const SCHEME = /^[a-z][\w+.-]+:/i
const OPENERS: Partial<Record<NodeJS.Platform, string[]>> = { darwin: ['open'], win32: ['cmd', '/c', 'start', ''] }

// The exit code a shell would report: the code, or 128 plus the signal.
export function exitCodeOf(code: number | null, signal: NodeJS.Signals | number | null): number {
  if (code !== null)
    return code

  if (typeof signal === 'number')
    return 128 + signal

  return signal === null ? 129 : 128 + constants.signals[signal]
}

// Takes SIGINT, SIGTERM and SIGHUP over until released. A signal goes to the child given to `forward`; without one, `cleanup` runs and the signal is raised again so the process ends as it would have; without either, it is only kept in `signal` for the caller to wind down on.
export function holdSignals(cleanup?: (signal: NodeJS.Signals) => void): HeldSignals {
  let received: NodeJS.Signals | undefined
  let child: Parameters<HeldSignals['forward']>[0] | undefined
  const held: HeldSignals = {
    get signal() {
      return received
    },
    forward: (to) => {
      child = to
    },
    release: () => {
      for (const signal of SIGNALS)
        process.off(signal, onSignal)
    },
  }

  function onSignal(signal: NodeJS.Signals) {
    received = signal

    if (child !== undefined) {
      child.kill(signal)

      return
    }

    if (cleanup === undefined)
      return

    held.release()
    cleanup(signal)
    process.kill(process.pid, signal)
  }

  for (const signal of SIGNALS)
    process.on(signal, onSignal)

  return held
}

// Opens a URL, or a file path, with the command BROWSER names or the platform's opener, run in `env` without waiting for it; false when that command cannot start.
export function openUrl(target: string, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const opener = env.BROWSER === undefined || env.BROWSER === '' ? OPENERS[platform] ?? ['xdg-open'] : [env.BROWSER]

  try {
    Bun.spawn([...opener, SCHEME.test(target) ? target : resolve(target)], { env, stdio: ['ignore', 'ignore', 'ignore'] }).unref()

    return true
  }
  catch {
    return false
  }
}

const CLIPBOARDS: string[][] = [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input'], ['pbcopy'], ['clip.exe']]

// Puts text on the system clipboard through the first of wl-copy, xclip, xsel, pbcopy and clip.exe found; false when none is there or it fails.
export async function copyText(text: string, which: (command: string) => string | null = Bun.which): Promise<boolean> {
  for (const [command, ...args] of CLIPBOARDS) {
    const found = which(command!)

    if (found !== null && await pipeInto([found, ...args], text))
      return true
  }

  return false
}

async function pipeInto(argv: string[], text: string): Promise<boolean> {
  try {
    const copy = Bun.spawn(argv, { stdin: new Blob([text]), stdout: 'ignore', stderr: 'ignore' })

    return await copy.exited === 0
  }
  catch {
    return false
  }
}

// Runs a command with stdout and stderr captured; throws when it cannot be started. With `timeoutMs`, `signal`, `onStart` or `onChunk` the child leads its own process group, and the whole group is ended (SIGTERM, then SIGKILL after a short grace) on the timeout, an abort or a throwing `onChunk`; the pipes are drained to their end either way.
export async function runCommand(argv: string[], { cwd, env, stdin = 'ignore', timeoutMs, signal, maxBytes = Infinity, onChunk, onStart }: RunSettings = {}): Promise<Ran> {
  const chunks: Chunk[] = []
  const grouped = timeoutMs !== undefined || signal !== undefined || onStart !== undefined || onChunk !== undefined
  const proc = Bun.spawn(argv, { ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env }), stdin, stdout: 'pipe', stderr: 'pipe', ...(grouped ? { detached: true } : {}) })
  const state = { kept: 0, truncated: false, timedOut: false, failure: undefined as unknown, done: false }
  const timers: ReturnType<typeof setTimeout>[] = []

  const killGroup = (killing: NodeJS.Signals) => {
    if (state.done)
      return

    try {
      if (grouped)
        process.kill(-proc.pid, killing)
      else
        proc.kill(killing)
    }
    catch {
      // The group is already gone.
    }
  }

  const stop = () => {
    killGroup('SIGTERM')
    timers.push(setTimeout(killGroup, KILL_GRACE_MS, 'SIGKILL'))
  }

  const onAbort = () => stop()

  if (timeoutMs !== undefined) {
    timers.push(setTimeout(() => {
      state.timedOut = true
      stop()
    }, timeoutMs))
  }

  if (signal?.aborted === true)
    onAbort()
  else
    signal?.addEventListener('abort', onAbort, { once: true })

  onStart?.({ kill: killing => killGroup(killing) })

  const drain = async (stream: ReadableStream<Uint8Array>, name: Chunk['stream']) => {
    for await (const data of stream) {
      if (state.failure !== undefined)
        continue

      try {
        onChunk?.({ stream: name, data })
      }
      catch (error) {
        state.failure = error
        stop()

        continue
      }

      if (state.kept + data.length > maxBytes) {
        state.truncated = true

        continue
      }

      state.kept += data.length
      chunks.push({ stream: name, data })
    }
  }

  try {
    await Promise.all([drain(proc.stdout, 'stdout'), drain(proc.stderr, 'stderr')])
    await proc.exited
  }
  finally {
    state.done = true

    for (const timer of timers)
      clearTimeout(timer)

    signal?.removeEventListener('abort', onAbort)
  }

  if (state.failure !== undefined)
    throw state.failure

  const joined = () => Buffer.concat(chunks.map(({ data }) => data))
  let output: Buffer | undefined
  let text: string | undefined

  return {
    code: exitCodeOf(proc.exitCode, proc.signalCode),
    chunks,
    timedOut: state.timedOut,
    truncated: state.truncated,
    get output() {
      return output ??= joined()
    },
    get text() {
      return text ??= (output ??= joined()).toString()
    },
  }
}
