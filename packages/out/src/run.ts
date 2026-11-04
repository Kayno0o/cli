import type { Chunk } from '@kaynooo/cli-kit'
import { closeSync, rmSync, writeSync } from 'node:fs'
import process from 'node:process'
import { holdSignals, runCommand } from '@kaynooo/cli-kit'
import { fold, shouldFold } from './fold'
import { cleanLogs, logDir, newLog } from './logs'
import { filtered } from './stages'
import { commandKey, record } from './stats'
import { tidy } from './tidy'

// Output kept in memory from the start and from the end; what lies between only reaches the log file.
const HEAD_BYTES = 2 * 1024 * 1024
const TAIL_BYTES = 2 * 1024 * 1024
const FALLBACK_LINES = 100

// Holds the first and last bytes of the output and streams all of it to a log file once it outgrows the memory it may take.
export class Recorder {
  readonly head: Chunk[] = []
  readonly tail: Chunk[] = []
  private headBytes = 0
  private tailBytes = 0
  private dropped = 0
  private log: { path: string, fd: number } | undefined
  private logFailed = false

  constructor(private readonly dir: string) {}

  add(chunk: Chunk): void {
    if (this.headBytes < HEAD_BYTES) {
      this.head.push(chunk)
      this.headBytes += chunk.data.length

      return
    }

    // Past the head, anything may be shed later, so the log starts here and gets every chunk after.
    this.writeToLog(chunk.data)
    this.tail.push(chunk)
    this.tailBytes += chunk.data.length

    while (this.tail.length > 1 && this.tailBytes - (this.tail[0]?.data.length ?? 0) >= TAIL_BYTES) {
      const gone = this.tail.shift()

      this.tailBytes -= gone?.data.length ?? 0
      this.dropped += gone?.data.length ?? 0
    }
  }

  // A log that cannot be written must not stop the wrapped command, so the output past the head is then only kept in memory.
  private writeToLog(data: Uint8Array): void {
    if (this.logFailed)
      return

    try {
      writeSync(this.startLog().fd, data)
    }
    catch (error) {
      this.logFailed = true
      console.error(`out: cannot write the log, the output past ${HEAD_BYTES} bytes is kept in memory only: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Opens the log when memory starts to be shed, giving it what is held so far.
  private startLog(): { path: string, fd: number } {
    if (this.log !== undefined)
      return this.log

    this.log = newLog(this.dir)

    for (const chunk of [...this.head, ...this.tail])
      writeSync(this.log.fd, chunk.data)

    return this.log
  }

  get overflowing(): boolean {
    return this.dropped > 0
  }

  get bytes(): number {
    return this.headBytes + this.tailBytes + this.dropped
  }

  get chunks(): Chunk[] {
    return [...this.head, ...this.tail]
  }

  // The log's path, writing the held output to a new one when none was started.
  save(): string {
    return this.startLog().path
  }

  // Removes the log a fold opened, once the output is printed untouched after all.
  discard(): void {
    if (this.log === undefined)
      return

    closeSync(this.log.fd)
    rmSync(this.log.path, { force: true })
    this.log = undefined
  }

  get text(): string {
    const decode = (chunks: Chunk[]) => Buffer.concat(chunks.map(({ data }) => data)).toString()

    if (this.dropped === 0)
      return decode(this.chunks)

    return `${decode(this.head)}\n[out: ${this.dropped} bytes left out of memory${this.logFailed ? '' : ', all of it is in the log'}]\n${decode(this.tail)}`
  }
}

// Writes the chunks tidied, and answers how many bytes that came to.
function replay(chunks: Chunk[]): number {
  let written = 0

  for (const { stream, data } of chunks) {
    const tidied = Buffer.from(tidy(Buffer.from(data).toString()))

    written += tidied.length
    process[stream].write(tidied)
  }

  return written
}

// What a run is recorded with: the words naming the command, and the tail, head or grep stages `out` stands in for.
export interface Recorded {
  command: string
  was: readonly string[]
}

// Counts the run in the stats: the session reads what `out` shows instead of the whole output, or of what the stages it replaced would have printed.
function count(recorder: Recorder, { shown, folded }: Presented, recorded: Recorded): void {
  const baseline = recorded.was.length === 0 || recorder.overflowing ? undefined : filtered(recorder.text, recorded.was)

  record({ at: new Date().toISOString(), dir: process.cwd(), command: recorded.command, bytes: recorder.bytes, baseline: baseline === undefined ? recorder.bytes : Buffer.byteLength(baseline), shown, folded })
}

// Runs the command with stdout and stderr captured in arrival order, then replays short output untouched or prints it folded. Returns the command's exit code, which a failure to fold never changes.
export async function run(command: string[], threshold: number, was: readonly string[] = []): Promise<number> {
  const dir = await logDir()

  await cleanLogs(dir)

  const recorder = new Recorder(dir)
  const held = holdSignals()
  let started = false
  let code: number

  try {
    const ran = await runCommand(command, {
      stdin: 'inherit',
      maxBytes: 0,
      onStart: (child) => {
        started = true
        held.forward(child)
      },
      onChunk: (chunk) => {
        recorder.add(chunk)
      },
    })

    code = ran.code
  }
  catch (error) {
    if (!started) {
      console.error(`out: cannot run ${command[0]}: ${error instanceof Error ? error.message : String(error)}`)

      return (error as { code?: unknown }).code === 'EACCES' ? 126 : 127
    }

    console.error(`out: ${error instanceof Error ? error.message : String(error)}`)
    code = 1
  }
  finally {
    held.release()
  }

  count(recorder, present(recorder, threshold), { command: commandKey(command), was })

  return code
}

// Reads output piped in and prints it as `run` does, untouched when short. Its exit code is 0: the writer's is the pipeline's to give, through `set -o pipefail`.
export async function readPiped(threshold: number, was: readonly string[] = []): Promise<number> {
  const dir = await logDir()

  await cleanLogs(dir)

  const recorder = new Recorder(dir)

  for await (const data of Bun.stdin.stream())
    recorder.add({ stream: 'stdout', data })

  count(recorder, present(recorder, threshold), { command: '(piped)', was })

  return 0
}

// How many bytes were printed, and whether the output was folded.
interface Presented {
  shown: number
  folded: boolean
}

// Prints the output tidied when short, folded otherwise.
function present(recorder: Recorder, threshold: number): Presented {
  const text = recorder.text

  if (!recorder.overflowing && !shouldFold(text, threshold))
    return { shown: replay(recorder.chunks), folded: false }

  let printed

  try {
    printed = fold(tidy(text), { threshold, logPath: recorder.save() })
  }
  catch (error) {
    console.error(`out: could not fold the output: ${error instanceof Error ? error.message : String(error)}`)
    printed = text.split('\n').slice(-FALLBACK_LINES).join('\n')
  }

  // A fold leaving little out can come out longer than the output once its header is added.
  if (!recorder.overflowing && Buffer.byteLength(printed) >= recorder.bytes) {
    recorder.discard()

    return { shown: replay(recorder.chunks), folded: false }
  }

  process.stdout.write(printed)

  return { shown: Buffer.byteLength(printed), folded: true }
}
