import type { HeldSignals } from '@kaynooo/cli-kit'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { formatDuration, privateLogDirectory, runCommand, stripAnsi, sweepLogs } from '@kaynooo/cli-kit'
import { failureExcerpt } from './output'

export interface Outcome { ok: boolean, ms: number, output: string, timedOut?: boolean }

export interface StepSettings {
  env?: Record<string, string>
  // Ends the step, and everything it started, after this long.
  timeoutMs?: number
  // Gets the signals this process receives passed on to the step.
  held?: HeldSignals
}

const LOG_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

// Where the steps' full outputs go: a folder of the user's own per run, the ones older than three days removed.
export async function logDirectory(cwd: string): Promise<string> {
  const root = await privateLogDirectory('check')

  await sweepLogs(root, LOG_MAX_AGE_MS)

  const path = join(root, `${basename(cwd)}-${Bun.hash(cwd).toString(36)}-${Date.now().toString(36)}-${process.pid}`)

  await mkdir(path, { mode: 0o700 })

  return path
}

// Saves a command's output in a log of the user's own, returning its path.
export async function saveLog(output: Uint8Array): Promise<string> {
  const root = await privateLogDirectory('errs')

  await sweepLogs(root)

  const path = join(root, `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}-${crypto.randomUUID().slice(0, 8)}.log`)

  await writeFile(path, output, { mode: 0o600, flag: 'wx' })

  return path
}

export async function runStep(command: string, cwd: string, logFile: string, { env = {}, timeoutMs, held }: StepSettings = {}): Promise<Outcome> {
  const started = Date.now()
  const { code, text, timedOut } = await runCommand(['sh', '-c', `${command} 2>&1`], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(held === undefined ? {} : { onStart: child => held.forward(child) }),
  })

  const output = stripAnsi(text)

  await writeFile(logFile, output, { mode: 0o600, flag: 'wx' })

  return { ok: code === 0, ms: Date.now() - started, output, ...(timedOut ? { timedOut } : {}) }
}

// A step's outcome as --json prints it, what failed under `failed` for a failing one.
export function outcomeJson(name: string, command: string, logFile: string, outcome: Outcome): { name: string, command: string, ok: boolean, ms: number, log: string, timedOut?: true, failed?: string } {
  return { name, command, ok: outcome.ok, ms: outcome.ms, log: logFile, ...(outcome.timedOut === true ? { timedOut: true as const } : {}), ...(outcome.ok ? {} : { failed: failureExcerpt(outcome.output) }) }
}

// One line for a passing step; for a failing one its command, then what failed, indented.
export function printOutcome(name: string, width: number, command: string, logFile: string, outcome: Outcome): void {
  if (outcome.ok) {
    console.log(`ok    ${name.padEnd(width)}  ${formatDuration(outcome.ms)}  ${logFile}`)

    return
  }

  const label = outcome.timedOut === true ? 'TIME ' : 'FAIL '

  console.log(`${label} ${name.padEnd(width)}  ${formatDuration(outcome.ms)}  ${command}  ${logFile}`)

  if (outcome.timedOut === true)
    console.log(`  timed out after ${formatDuration(outcome.ms)}, the step and what it started were ended`)

  console.log(failureExcerpt(outcome.output).split('\n').map(line => `  ${line}`.trimEnd()).join('\n'))
}
