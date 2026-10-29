import type { Step } from './steps'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { fail, formatDuration, parse, runCommand, stripAnsi, table } from '@kaynooo/cli-kit'
import { failureExcerpt } from './output'
import { discover, STEP_NAMES } from './steps'

const usage = `check [--only <steps>] [--list]

Runs the repo's check, typecheck, lint and test steps, from package.json scripts (through bun run), composer.json, a Justfile or a Makefile.
A passing step is one line, a failing one shows only what failed, and each step's full output is saved to the file whose path ends its line.
Exits 0 when every step passed, 1 when one failed, 2 on bad usage or when no step is found.`

const options = {
  list: { type: 'boolean', short: 'l', description: 'print the steps found and the commands that run them, without running them' },
  only: { type: 'string', short: 'o', description: `comma separated steps to run, among ${STEP_NAMES.join(', ')}` },
} as const

const COMMA = /\s*,\s*/

// Where the steps' full outputs go: one folder per repo, rewritten by the next run.
function logDirectory(cwd: string): string {
  return join(tmpdir(), 'check', `${basename(cwd)}-${Bun.hash(cwd).toString(36)}`)
}

function pick(steps: Step[], only: string | undefined): Step[] {
  if (only === undefined)
    return steps

  const names = only.split(COMMA).filter(name => name !== '')
  const unknown = names.filter(name => !steps.some(step => step.name === name))

  if (unknown.length > 0)
    fail(`no ${unknown.join(', ')} step here, found ${steps.map(step => step.name).join(', ')}`)

  return steps.filter(step => names.includes(step.name))
}

async function runStep(step: Step, cwd: string, logFile: string): Promise<{ ok: boolean, ms: number, output: string }> {
  const started = Date.now()
  const { code, text } = await runCommand(['sh', '-c', `${step.command} 2>&1`], { cwd, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
  const output = stripAnsi(text)

  await Bun.write(logFile, output)

  return { ok: code === 0, ms: Date.now() - started, output }
}

// Runs the repo's steps in order and prints one line each, with what failed under a failing one; returns 0 only when every step passed.
export async function check(args: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parse(args, usage, options)

  if (parsed === undefined)
    return 0

  const found = await discover(cwd)

  if (found.length === 0)
    fail(`no ${STEP_NAMES.join(', ')} step in package.json, composer.json, a Justfile or a Makefile`)

  const steps = pick(found, parsed.values.only)

  if (parsed.values.list === true) {
    console.log(table(steps.map(step => [step.name, step.command, step.source])))

    return 0
  }

  const directory = logDirectory(cwd)

  await mkdir(directory, { recursive: true })

  const width = Math.max(...steps.map(step => step.name.length))
  let failed = 0

  for (const step of steps) {
    const logFile = join(directory, `${step.name}.log`)
    const result = await runStep(step, cwd, logFile)

    if (result.ok) {
      console.log(`ok    ${step.name.padEnd(width)}  ${formatDuration(result.ms)}  ${logFile}`)

      continue
    }

    failed++
    console.log(`FAIL  ${step.name.padEnd(width)}  ${formatDuration(result.ms)}  ${step.command}  ${logFile}`)
    console.log(failureExcerpt(result.output).split('\n').map(line => `  ${line}`.trimEnd()).join('\n'))
  }

  return failed === 0 ? 0 : 1
}
