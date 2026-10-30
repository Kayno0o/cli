import { existsSync, statSync } from 'node:fs'

// Lines kept from the end of the file for a timeout's excerpt, and on each side of a failure line.
const TAIL = 20
const AROUND = 5
const CARRIAGE_RETURN = /\r$/

export interface Line {
  number: number
  text: string
}

export type FileEvent = { kind: 'until', line: Line } | { kind: 'fail', line: Line, excerpt: Line[] }

interface Failure {
  before: Line[]
  line: Line
  after: Line[]
  waited: boolean
}

// Reads a growing file from the start, a line at a time as each is completed, starting over when it shrinks (rotated or truncated).
export class FileWatch {
  private offset = 0
  private decoder = new TextDecoder()
  private partial = ''
  private number = 0
  private recent: Line[] = []
  private failure: Failure | undefined
  private matched = false

  constructor(readonly path: string, private readonly until: RegExp | undefined, private readonly failOn: RegExp | undefined) {}

  get done(): boolean {
    return this.until === undefined || this.matched
  }

  get failing(): boolean {
    return this.failure !== undefined
  }

  get exists(): boolean {
    return existsSync(this.path)
  }

  // The events the new lines bring: the --until match, and a --fail match once the lines after it were read or one more poll found no more.
  async poll(): Promise<FileEvent[]> {
    const events: FileEvent[] = []

    for (const line of await this.newLines()) {
      if (this.failure !== undefined) {
        if (this.failure.after.length < AROUND)
          this.failure.after.push(line)

        continue
      }

      if (this.failOn?.test(line.text) === true) {
        this.failure = { before: this.recent.slice(-AROUND), line, after: [], waited: false }

        continue
      }

      this.recent.push(line)

      if (this.recent.length > TAIL)
        this.recent.shift()

      if (!this.matched && this.until?.test(line.text) === true) {
        this.matched = true
        events.push({ kind: 'until', line })
      }
    }

    if (this.failure !== undefined && !this.failure.waited && this.failure.after.length < AROUND)
      this.failure.waited = true
    else if (this.failure !== undefined)
      events.push({ kind: 'fail', line: this.failure.line, excerpt: [...this.failure.before, this.failure.line, ...this.failure.after] })

    return events
  }

  // What the file last showed, for a timeout.
  excerpt(): Line[] {
    return this.recent
  }

  private async newLines(): Promise<Line[]> {
    if (!existsSync(this.path))
      return []

    const size = statSync(this.path).size

    if (size < this.offset) {
      this.offset = 0
      this.decoder = new TextDecoder()
      this.partial = ''
      this.number = 0
      this.recent = []
    }

    if (size === this.offset)
      return []

    // Streamed, so a read ending inside a multibyte character keeps its first bytes for the next one.
    const chunk = this.decoder.decode(await Bun.file(this.path).slice(this.offset, size).bytes(), { stream: true })

    this.offset = size

    const pieces = (this.partial + chunk).split('\n')

    this.partial = pieces.pop() ?? ''

    return pieces.map(text => ({ number: ++this.number, text: Bun.stripANSI(text.replace(CARRIAGE_RETURN, '')) }))
  }
}

// Undefined once something accepts connections on the port, else why the connection failed.
export async function portProblem(host: string, port: number): Promise<string | undefined> {
  try {
    const socket = await Bun.connect({ hostname: host, port, socket: { data: socket => void socket.end() } })

    socket.end()

    return undefined
  }
  catch (error) {
    return error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : String(error)
  }
}

// The status once the URL answers 2xx, else what it answered or why it could not.
export async function urlCheck(url: string, timeout: number): Promise<{ status: number } | { problem: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })

    await response.body?.cancel()

    return response.ok ? { status: response.status } : { problem: `answered ${response.status}` }
  }
  catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) }
  }
}
