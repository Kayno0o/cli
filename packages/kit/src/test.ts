import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { format } from 'node:util'
import { afterAll } from 'bun:test'

export interface Captured<T> {
  result: T
  // Everything printed to stdout (console.log, console.info and process.stdout.write).
  out: string
  // Everything printed to stderr (console.error, console.warn and process.stderr.write).
  err: string
}

// Called at the top of a test file, answers a maker of fresh folders under the system temp folder, each removed with its content once the file's tests are done.
export function tempDirs(): (prefix?: string) => string {
  const made: string[] = []

  afterAll(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true })
  })

  return (prefix = 'test-') => {
    const dir = mkdtempSync(join(tmpdir(), prefix))

    made.push(dir)

    return dir
  }
}

// Runs a command in-process and returns what it printed, so a test needs no spy on console. Output is restored even when the command throws.
export async function capture<T>(run: () => Promise<T> | T): Promise<Captured<T>> {
  const written = { out: '', err: '' }
  const saved = { log: console.log, info: console.info, error: console.error, warn: console.warn, stdout: process.stdout.write.bind(process.stdout), stderr: process.stderr.write.bind(process.stderr) }
  const line = (name: 'out' | 'err') => (...parts: unknown[]) => {
    written[name] += `${format(...parts)}\n`
  }
  const chunk = (name: 'out' | 'err') => (data: string | Uint8Array) => {
    written[name] += typeof data === 'string' ? data : Buffer.from(data).toString()

    return true
  }

  console.log = line('out')
  console.info = line('out')
  console.error = line('err')
  console.warn = line('err')
  process.stdout.write = chunk('out')
  process.stderr.write = chunk('err')

  try {
    const result = await run()

    return { result, ...written }
  }
  finally {
    Object.assign(console, { log: saved.log, info: saved.info, error: saved.error, warn: saved.warn })
    process.stdout.write = saved.stdout
    process.stderr.write = saved.stderr
  }
}
