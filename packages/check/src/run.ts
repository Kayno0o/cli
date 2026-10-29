import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { formatDuration, runCommand, stripAnsi } from '@kaynooo/cli-kit'
import { failureExcerpt } from './output'

export interface Outcome { ok: boolean, ms: number, output: string }

// Where the steps' full outputs go: one folder per repo, rewritten by the next run.
export function logDirectory(cwd: string): string {
  return join(tmpdir(), 'check', `${basename(cwd)}-${Bun.hash(cwd).toString(36)}`)
}

export async function runStep(command: string, cwd: string, logFile: string, env: Record<string, string> = {}): Promise<Outcome> {
  const started = Date.now()
  const { code, text } = await runCommand(['sh', '-c', `${command} 2>&1`], { cwd, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env } })
  const output = stripAnsi(text)

  await Bun.write(logFile, output)

  return { ok: code === 0, ms: Date.now() - started, output }
}

// One line for a passing step; for a failing one its command, then what failed, indented.
export function printOutcome(name: string, width: number, command: string, logFile: string, outcome: Outcome): void {
  if (outcome.ok) {
    console.log(`ok    ${name.padEnd(width)}  ${formatDuration(outcome.ms)}  ${logFile}`)

    return
  }

  console.log(`FAIL  ${name.padEnd(width)}  ${formatDuration(outcome.ms)}  ${command}  ${logFile}`)
  console.log(failureExcerpt(outcome.output).split('\n').map(line => `  ${line}`.trimEnd()).join('\n'))
}
