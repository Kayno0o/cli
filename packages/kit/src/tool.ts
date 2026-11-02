import type { RunSettings } from './process'
import process from 'node:process'
import { formatDuration } from './format'
import { runCommand } from './process'

export interface ToolRun {
  code: number
  stdout: string
  stderr: string
}

// What an answer says when retrying it can only give the same answer: an expired token, a missing permission, a route or repository that does not exist.
const PERMANENT = /\bHTTP (?:401|403|404)\b|unauthorized|forbidden|not found|couldn't be found|token is required/i

// True once the directory the process runs in was deleted, as a worktree is after its work lands.
export function cwdGone(): boolean {
  try {
    process.cwd()

    return false
  }
  catch {
    return true
  }
}

class SpawnError extends Error {
  constructor(message: string, readonly missing: boolean) {
    super(message)
  }
}

// A spawn failing before the command runs says only "No such file or directory", which names the working directory once it was deleted.
export function spawnFailure(command: string, error: unknown): Error {
  const gone = cwdGone()
  const missing = !gone && (error as { code?: unknown } | undefined)?.code === 'ENOENT'

  return new SpawnError(`${command}: ${error instanceof Error ? error.message : String(error)}${gone ? ' (the working directory was removed)' : ''}`, missing)
}

// True for a failure a poll cannot recover from: a binary that is not installed, or an answer of 401, 403 or 404.
export function isPermanentFailure(error: unknown): boolean {
  if (!(error instanceof Error))
    return false

  return (error instanceof SpawnError && error.missing) || PERMANENT.test(error.message)
}

// Runs a command and returns its code and both streams; throws, naming `label`, when it cannot start or outlives `timeoutMs`.
export async function runTool(label: string, argv: string[], { timeoutMs, cwd, onStart }: { [K in 'timeoutMs' | 'cwd' | 'onStart']?: RunSettings[K] | undefined } = {}): Promise<ToolRun> {
  let ran

  try {
    // The environment is passed whole so the program is looked up on the PATH as it is now, not as the process started with.
    ran = await runCommand(argv, { env: process.env, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(cwd === undefined ? {} : { cwd }), ...(onStart === undefined ? {} : { onStart }) })
  }
  catch (error) {
    throw spawnFailure(label, error)
  }

  if (ran.timedOut)
    throw new Error(`${label}: no answer in ${formatDuration(timeoutMs ?? 0)}`)

  const decoder = new TextDecoder()
  const streams = { stdout: '', stderr: '' }

  for (const { stream, data } of ran.chunks)
    streams[stream] += decoder.decode(data, { stream: true })

  return { code: ran.code, ...streams }
}
