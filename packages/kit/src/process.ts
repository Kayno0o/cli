import { constants } from 'node:os'

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

// Runs a command with stdout and stderr captured; throws when it cannot be started.
export async function runCommand(argv: string[], { cwd, env, stdin = 'ignore' }: RunSettings = {}): Promise<Ran> {
  const chunks: Chunk[] = []
  const proc = Bun.spawn(argv, { ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env }), stdin, stdout: 'pipe', stderr: 'pipe' })

  await Promise.all([collect(proc.stdout, 'stdout', chunks), collect(proc.stderr, 'stderr', chunks)])
  await proc.exited

  const output = Buffer.concat(chunks.map(({ data }) => data))

  return { code: exitCodeOf(proc.exitCode, proc.signalCode), chunks, output, text: output.toString() }
}
