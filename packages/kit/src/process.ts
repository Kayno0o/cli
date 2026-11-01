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
}

export interface RunSettings {
  cwd?: string
  env?: Record<string, string | undefined>
  stdin?: 'inherit' | 'ignore'
}

export interface HeldSignals {
  // The last signal received, undefined while none has come.
  readonly signal: NodeJS.Signals | undefined
  // Passes each signal received from now on to `child`, so it ends and its code is the one to exit with.
  forward: (child: { kill: (signal: NodeJS.Signals) => unknown }) => void
  // Takes the handlers off again, and may be called more than once.
  release: () => void
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
// A scheme of two letters or more, so a Windows drive is read as a path.
const SCHEME = /^[a-z][\w+.-]+:/i
const OPENERS: Partial<Record<NodeJS.Platform, string[]>> = { darwin: ['open'], win32: ['cmd', '/c', 'start', ''] }

async function collect(stream: ReadableStream<Uint8Array>, name: Chunk['stream'], chunks: Chunk[]): Promise<void> {
  for await (const data of stream)
    chunks.push({ stream: name, data })
}

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

// Runs a command with stdout and stderr captured; throws when it cannot be started.
export async function runCommand(argv: string[], { cwd, env, stdin = 'ignore' }: RunSettings = {}): Promise<Ran> {
  const chunks: Chunk[] = []
  const proc = Bun.spawn(argv, { ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env }), stdin, stdout: 'pipe', stderr: 'pipe' })

  await Promise.all([collect(proc.stdout, 'stdout', chunks), collect(proc.stderr, 'stderr', chunks)])
  await proc.exited

  const output = Buffer.concat(chunks.map(({ data }) => data))

  return { code: exitCodeOf(proc.exitCode, proc.signalCode), chunks, output, text: output.toString() }
}
