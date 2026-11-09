import type { HeldSignals } from '@kaynooo/cli-kit'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { formatDuration, paint, privateLogDirectory, role, runCommand, stripAnsi, sweepLogs } from '@kaynooo/cli-kit'
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

// Written in a run folder when the run ends: the name and result of each step that ran, for --failed.
export const RESULTS_FILE = 'results.json'

const runPrefix = (cwd: string) => `${basename(cwd)}-${Bun.hash(cwd).toString(36)}-`

// Where the steps' full outputs go: a folder of the user's own per run, the ones older than three days removed.
export async function logDirectory(cwd: string): Promise<string> {
  const root = await privateLogDirectory('check')

  await sweepLogs(root, LOG_MAX_AGE_MS)

  const path = join(root, `${runPrefix(cwd)}${Date.now().toString(36)}-${process.pid}`)

  await mkdir(path, { mode: 0o700 })

  return path
}

// The results of the folder's latest finished run, undefined when it has none.
export async function lastResults(cwd: string): Promise<{ name: string, ok: boolean }[] | undefined> {
  const root = await privateLogDirectory('check')
  const prefix = runPrefix(cwd)
  let latest: { time: number, file: string } | undefined

  for (const name of await readdir(root)) {
    if (!name.startsWith(prefix))
      continue

    const file = join(root, name, RESULTS_FILE)

    try {
      const { mtimeMs } = await stat(file)

      if (latest === undefined || mtimeMs > latest.time)
        latest = { time: mtimeMs, file }
    }
    catch {
      // A run still going, or one that was interrupted, has no results yet.
    }
  }

  if (latest === undefined)
    return undefined

  return JSON.parse(await Bun.file(latest.file).text()) as { name: string, ok: boolean }[]
}

// The names of the steps that failed in the folder's latest finished run, undefined when it has none.
export async function lastFailed(cwd: string): Promise<string[] | undefined> {
  return (await lastResults(cwd))?.filter(result => !result.ok).map(result => result.name)
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

// A step that could not start: its failure is the reason, saved to its log like any output.
export async function refusedStep(reason: string, logFile: string): Promise<Outcome> {
  await writeFile(logFile, reason, { mode: 0o600, flag: 'wx' })

  return { ok: false, ms: 0, output: reason }
}

// A step's outcome as --json prints it, what failed under `failed` for a failing one and the compose service it ran in under `in`.
export function outcomeJson(name: string, command: string, logFile: string, outcome: Outcome, service?: string): { name: string, command: string, in?: string, ok: boolean, ms: number, log: string, timedOut?: true, failed?: string } {
  return { name, command, ...(service === undefined ? {} : { in: service }), ok: outcome.ok, ms: outcome.ms, log: logFile, ...(outcome.timedOut === true ? { timedOut: true as const } : {}), ...(outcome.ok ? {} : { failed: failureExcerpt(outcome.output) }) }
}

// One line for a passing step; for a failing one its command, then what failed, indented.
export function printOutcome(name: string, width: number, command: string, logFile: string, outcome: Outcome): void {
  const colors = paint(process.stdout)
  const path = role('path', process.stdout)
  const took = colors.dim(formatDuration(outcome.ms))

  if (outcome.ok) {
    console.log(`${colors.bold(colors.green('ok   '))} ${name.padEnd(width)}  ${took}  ${path(logFile)}`)

    return
  }

  const label = outcome.timedOut === true ? colors.bold(colors.yellow('TIME ')) : colors.bold(colors.red('FAIL '))

  console.log(`${label} ${name.padEnd(width)}  ${took}  ${colors.dim(command)}  ${path(logFile)}`)

  if (outcome.timedOut === true)
    console.log(colors.yellow(`  timed out after ${formatDuration(outcome.ms)}, the step and what it started were ended`))

  console.log(failureExcerpt(outcome.output).split('\n').map(line => `  ${line}`.trimEnd()).join('\n'))
}
