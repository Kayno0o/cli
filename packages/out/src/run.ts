import { constants } from 'node:os'
import process from 'node:process'
import { fold, shouldFold } from './fold'
import { saveLog } from './logs'

interface Chunk {
  stream: 'stdout' | 'stderr'
  data: Uint8Array
}

async function collect(stream: ReadableStream<Uint8Array>, name: Chunk['stream'], chunks: Chunk[]): Promise<void> {
  for await (const data of stream)
    chunks.push({ stream: name, data })
}

export function exitCodeOf(code: number | null, signal: NodeJS.Signals | number | null): number {
  if (code !== null)
    return code

  if (typeof signal === 'number')
    return 128 + signal

  return signal === null ? 129 : 128 + constants.signals[signal]
}

// Runs the command with stdout and stderr captured in arrival order, then replays short output untouched or prints it folded. Returns the command's exit code.
export async function run(command: string[], threshold: number): Promise<number> {
  const chunks: Chunk[] = []
  let proc

  try {
    proc = Bun.spawn(command, { stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' })
  }
  catch (error) {
    console.error(`out: cannot run ${command[0]}: ${error instanceof Error ? error.message : String(error)}`)

    return 127
  }

  await Promise.all([collect(proc.stdout, 'stdout', chunks), collect(proc.stderr, 'stderr', chunks)])
  await proc.exited

  const code = exitCodeOf(proc.exitCode, proc.signalCode)
  const output = Buffer.concat(chunks.map(({ data }) => data))
  const text = output.toString()

  if (!shouldFold(text, threshold)) {
    for (const { stream, data } of chunks)
      process[stream].write(data)

    return code
  }

  process.stdout.write(fold(text, { threshold, logPath: await saveLog(output) }))

  return code
}
