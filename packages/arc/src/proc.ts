import type { FileSink } from 'bun'
import { availableParallelism } from 'node:os'
import process from 'node:process'
import { fail, formatSize, marked, writeErr } from '@kaynooo/cli-kit'

// tar's flags for a faithful copy: numeric owners, ACLs and extended attributes.
export const TAR_FIDELITY = ['--numeric-owner', '--acls', '--xattrs']
// Allows zstd decompression/testing to read archives made with any --long window (including older arc --long=27 archives) without extra RAM on normal archives.
export const ZSTD_DECODE_LONG = '--long=31'
// Default zstd compression level: fast and low-memory instead of level 10's heavy tables.
export const DEFAULT_LEVEL = 3

// Uses at most half the machine's cores (capped at 4) so packing never starves a server.
export function defaultThreads(): number {
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))
}

// Wraps a CPU-heavy command in `nice -n 10` when available so background services stay responsive.
export function niced(argv: string[]): string[] {
  return Bun.which('nice') === null ? argv : ['nice', '-n', '10', ...argv]
}

export interface Ran {
  code: number
  stdout: string
  stderr: string
}

export interface PipelineResult {
  codes: [number, number]
  stdout: string
  stderr: string
}

export interface PipelineOptions {
  capture?: boolean
  onBytes?: (bytes: number) => void
  cwd?: string
  stderr?: 'pipe' | 'inherit' | 'ignore'
}

export interface ByteProgress {
  done?: number
  total?: number
  unit?: string
}

// Writes a non-error note to stderr without using console.error (which Bun tints red on a TTY).
export function say(message: string): void {
  writeErr(marked('note', message, process.stderr))
}

function unitScale(total: number): [string, number] {
  if (total >= 10 * 1024 ** 2)
    return ['MiB', 1024 ** 2]

  return total >= 10 * 1024 ? ['KiB', 1024] : ['B', 1]
}

// Formats byte progress for `progressLine`, scaling to B/KiB/MiB with percent and throughput once >0.5s has elapsed.
export function byteProgress(done: number, total: number | undefined, elapsedMs?: number): ByteProgress {
  if (total === undefined || total <= 0)
    return {}

  const [label, scale] = unitScale(total)
  const scaledTotal = Math.max(1, Math.ceil(total / scale))
  const scaledDone = Math.min(Math.floor(done / scale), scaledTotal)
  const pct = Math.min(100, Math.round((done / total) * 100))
  const speed = elapsedMs !== undefined && elapsedMs >= 500 && done > 0
    ? `, ${formatSize(Math.round(done / (elapsedMs / 1000)))}/s`
    : ''

  return { done: scaledDone, total: scaledTotal, unit: `${label} (${pct}%${speed})` }
}

// Formats a `before -> after (ratio%)` summary string for archive operations.
export function ratioSummary(before: number, after: number): string {
  const pct = before > 0 ? ` (${Math.round((after / before) * 100)}%)` : ''

  return `${formatSize(before)} -> ${formatSize(after)}${pct}`
}

async function cancelQuietly(reader: { cancel: () => Promise<void> }): Promise<void> {
  try {
    await reader.cancel()
  }
  catch {
    // Stream already closed or errored.
  }
}

// Streams chunks from `source` into `sink`, reporting cumulative bytes and swallowing broken-pipe errors when the consumer exits early.
export async function pump(source: ReadableStream<Uint8Array>, sink: FileSink, onBytes?: (bytes: number) => void): Promise<number> {
  const reader = source.getReader()
  let bytes = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done)
        break

      bytes += value.byteLength
      onBytes?.(bytes)

      try {
        const written = sink.write(value)

        if (written instanceof Promise)
          await written
      }
      catch {
        await cancelQuietly(reader)

        break
      }
    }
  }
  finally {
    reader.releaseLock()

    try {
      await sink.end()
    }
    catch {
      // Consumer already closed stdin (e.g. failed early); its exit code reports the failure.
    }
  }

  return bytes
}

async function pumpAndWait(source: ReadableStream<Uint8Array>, sink: FileSink, exited: Promise<number>, onBytes?: (bytes: number) => void): Promise<number> {
  await pump(source, sink, onBytes)

  return exited
}

// Runs a command with its stderr captured (or inherited), answering its exit code, stdout and stderr.
export async function run(argv: string[], stderr: 'pipe' | 'inherit' | 'ignore' = 'pipe'): Promise<Ran> {
  const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr })
  const [stdout, err, code] = await Promise.all([
    child.stdout.text(),
    stderr === 'pipe' ? new Response(child.stderr as ReadableStream).text() : Promise.resolve(''),
    child.exited,
  ])

  return { code, stdout, stderr: err }
}

// Like `run`, with stderr thrown away, for a probe whose failure is an answer.
export async function probe(argv: string[]): Promise<Ran> {
  const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const [stdout, code] = await Promise.all([child.stdout.text(), child.exited])

  return { code, stdout, stderr: '' }
}

// `left | right`, optionally counting bytes between stages and capturing stdout/stderr.
export async function pipeline(left: string[], right: string[], options: PipelineOptions = {}): Promise<PipelineResult> {
  const { capture = false, onBytes, cwd, stderr = 'pipe' } = options
  const first = Bun.spawn(left, { ...cwd === undefined ? {} : { cwd }, stdin: 'ignore', stdout: 'pipe', stderr })

  if (onBytes === undefined) {
    const second = Bun.spawn(right, { ...cwd === undefined ? {} : { cwd }, stdin: first.stdout, stdout: capture ? 'pipe' : 'inherit', stderr })
    const [stdout, errA, errB, a, b] = await Promise.all([
      capture ? new Response(second.stdout as ReadableStream).text() : Promise.resolve(''),
      stderr === 'pipe' ? new Response(first.stderr as ReadableStream).text() : Promise.resolve(''),
      stderr === 'pipe' ? new Response(second.stderr as ReadableStream).text() : Promise.resolve(''),
      first.exited,
      second.exited,
    ])

    return { codes: [a, b], stdout, stderr: joinStderr(errA, errB) }
  }

  const second = Bun.spawn(right, { ...cwd === undefined ? {} : { cwd }, stdin: 'pipe', stdout: capture ? 'pipe' : 'inherit', stderr })
  const [stdout, errA, errB, a, b] = await Promise.all([
    capture ? new Response(second.stdout as ReadableStream).text() : Promise.resolve(''),
    stderr === 'pipe' ? new Response(first.stderr as ReadableStream).text() : Promise.resolve(''),
    stderr === 'pipe' ? new Response(second.stderr as ReadableStream).text() : Promise.resolve(''),
    pumpAndWait(first.stdout, second.stdin, first.exited, onBytes),
    second.exited,
  ])

  return { codes: [a, b], stdout, stderr: joinStderr(errA, errB) }
}

// Streams `filePath` into `argv`'s stdin, counting compressed/input bytes along the way.
export async function feedFile(filePath: string, argv: string[], options: PipelineOptions & { outFile?: string } = {}): Promise<Ran> {
  const { capture = false, onBytes, cwd, stderr = 'pipe', outFile } = options
  let stdoutMode: 'pipe' | 'inherit' | ReturnType<typeof Bun.file> = capture ? 'pipe' : 'inherit'

  if (outFile !== undefined)
    stdoutMode = Bun.file(outFile)

  const child = Bun.spawn(argv, { ...cwd === undefined ? {} : { cwd }, stdin: 'pipe', stdout: stdoutMode, stderr })
  const [stdout, err, code] = await Promise.all([
    capture && outFile === undefined ? new Response(child.stdout as ReadableStream).text() : Promise.resolve(''),
    stderr === 'pipe' ? new Response(child.stderr as ReadableStream).text() : Promise.resolve(''),
    pumpAndWait(Bun.file(filePath).stream(), child.stdin, child.exited, onBytes),
  ])

  return { code, stdout, stderr: err.trim() }
}

// Streams `filePath` into `left | right`, counting bytes read from `filePath` while `left | right` runs over an OS pipe.
export async function feedPipeline(filePath: string, left: string[], right: string[], options: PipelineOptions = {}): Promise<PipelineResult> {
  const { capture = false, onBytes, cwd, stderr = 'pipe' } = options
  const first = Bun.spawn(left, { ...cwd === undefined ? {} : { cwd }, stdin: 'pipe', stdout: 'pipe', stderr })
  const second = Bun.spawn(right, { ...cwd === undefined ? {} : { cwd }, stdin: first.stdout, stdout: capture ? 'pipe' : 'inherit', stderr })
  const [stdout, errA, errB, a, b] = await Promise.all([
    capture ? new Response(second.stdout as ReadableStream).text() : Promise.resolve(''),
    stderr === 'pipe' ? new Response(first.stderr as ReadableStream).text() : Promise.resolve(''),
    stderr === 'pipe' ? new Response(second.stderr as ReadableStream).text() : Promise.resolve(''),
    pumpAndWait(Bun.file(filePath).stream(), first.stdin, first.exited, onBytes),
    second.exited,
  ])

  return { codes: [a, b], stdout, stderr: joinStderr(errA, errB) }
}

// Runs a command on the terminal, its output shown and its prompts answerable, answering its exit code.
export async function interactive(argv: string[], cwd = process.cwd()): Promise<number> {
  return Bun.spawn(argv, { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited
}

// Validates sudo credentials interactively before any live progress bar takes over the terminal.
export async function ensureSudo(): Promise<boolean> {
  return await interactive(['sudo', '-v']) === 0
}

export function lines(text: string): string[] {
  return text.split('\n').filter(line => line !== '')
}

export function need(bin: string): void {
  if (Bun.which(bin) === null)
    fail(`${bin} is not on PATH`, 1)
}

function joinStderr(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join('\n')
}
