import process from 'node:process'
import { fail } from '@kaynooo/cli-kit'

// tar's flags for a faithful copy: numeric owners, ACLs and extended attributes.
export const TAR_FIDELITY = ['--numeric-owner', '--acls', '--xattrs']
// zstd's long-distance window, the same on both sides of an archive.
export const ZSTD_LONG = '--long=27'

export interface Ran {
  code: number
  stdout: string
}

// Runs a command with its stderr shown, answering its exit code and stdout.
export async function run(argv: string[]): Promise<Ran> {
  const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
  const [stdout, code] = await Promise.all([child.stdout.text(), child.exited])

  return { code, stdout }
}

// Like `run`, with stderr thrown away, for a probe whose failure is an answer.
export async function probe(argv: string[]): Promise<Ran> {
  const child = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const [stdout, code] = await Promise.all([child.stdout.text(), child.exited])

  return { code, stdout }
}

// `left | right`, the exit code of each, the output of `right` captured when `capture` is set and shown otherwise.
export async function pipeline(left: string[], right: string[], capture = false): Promise<{ codes: [number, number], stdout: string }> {
  const first = Bun.spawn(left, { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
  const second = Bun.spawn(right, { stdin: first.stdout, stdout: capture ? 'pipe' : 'inherit', stderr: 'inherit' })
  const [stdout, a, b] = await Promise.all([capture ? new Response(second.stdout as ReadableStream).text() : Promise.resolve(''), first.exited, second.exited])

  return { codes: [a, b], stdout }
}

// Runs a command on the terminal, its output shown and its prompts answerable, answering its exit code.
export async function interactive(argv: string[], cwd = process.cwd()): Promise<number> {
  return Bun.spawn(argv, { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exited
}

export function lines(text: string): string[] {
  return text.split('\n').filter(line => line !== '')
}

export function need(bin: string): void {
  if (Bun.which(bin) === null)
    fail(`${bin} is not on PATH`, 1)
}
