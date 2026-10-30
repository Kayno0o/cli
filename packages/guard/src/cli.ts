#!/usr/bin/env bun

import type { Context, Verdict, Violation } from './check'
import type { Event, HookInput, Machine } from './hook'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import process from 'node:process'
import { fail, parse, readInput, runCli, runCommand } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { checkCommand, checkPath } from './check'
import { EVENTS, hook } from './hook'

const checkUsage = `guard check [options] [<command> | -]

Checks a shell command against the rules: remote machines, git (stash, whole-tree add and commit, push, tags), commit messages, SQL writes, env files and package managers.
Prints each broken rule with the route to take instead and exits 1, prints nothing and exits 0 when the command is clean.
The command is read from stdin with - or when none is given; a rule may rewrite it instead (the pinned package manager, a noisy run through out), printed as \`runs as: <command>\`.`

const checkOptions = {
  'json': { type: 'boolean', description: 'print {violations, command, notes, packages} for a hook' },
  'cwd': { type: 'string', description: 'the directory the command runs in (default: here)' },
  'push-asked': { type: 'boolean', description: 'the user asked for a push, so git push may run' },
  'no-wrap': { type: 'boolean', description: 'never route a noisy command through out' },
} as const

const pathUsage = `guard path [--json] <path>...

Checks the paths a file tool would read, edit or write: env files are refused.`

const pathOptions = {
  json: { type: 'boolean', description: 'print {violations} for a hook' },
} as const

const hookUsage = `guard hook <${EVENTS.join('|')}>

Answers a Claude Code hook: reads the event JSON on stdin and prints the reply JSON, nothing when the call goes ahead untouched.
pre-tool-use refuses a Bash call breaking a rule, an install pkg refuses, and a Read, Edit or Write of an env file; user-prompt-submit remembers whether the prompt asked for a push; session-start lists the installed agent-tools bins.
A failure exits 1, which Claude Code reports without blocking the call.`

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return null
  }
}

function report(violations: Violation[]) {
  for (const { rule, message } of violations)
    console.log(`${rule}: ${message}`)
}

async function check(args: string[]): Promise<number> {
  const parsed = parse(args, checkUsage, checkOptions)

  if (parsed === undefined)
    return 0

  const { values, positionals } = parsed

  if (positionals.length > 1)
    fail(`give the command as one argument, quoted\n\n${checkUsage}`)

  const given = positionals[0] ?? '-'
  const command = given === '-' ? await readInput('-', { noStdin: 'give the command, or pipe it on stdin' }) : given
  const context: Context = {
    cwd: values.cwd ?? process.cwd(),
    home: homedir(),
    isPushAsked: values['push-asked'] === true,
    canRewrite: true,
    canWrap: values['no-wrap'] !== true && Bun.which('out') !== null,
    read: readText,
    exists: existsSync,
  }
  const verdict: Verdict = await checkCommand(command, context)

  if (values.json === true)
    console.log(JSON.stringify(verdict))
  else
    report(verdict.violations)

  if (values.json !== true && verdict.command !== command)
    console.log(`runs as: ${verdict.command}${verdict.notes.map(note => `\n${note}`).join('')}`)

  return verdict.violations.length > 0 ? 1 : 0
}

function path(args: string[]): number {
  const parsed = parse(args, pathUsage, pathOptions)

  if (parsed === undefined)
    return 0

  if (parsed.positionals.length === 0)
    fail(`give at least one path\n\n${pathUsage}`)

  const violations = parsed.positionals.flatMap(each => checkPath(each) ?? [])

  if (parsed.values.json === true)
    console.log(JSON.stringify({ violations }))
  else
    report(violations)

  return violations.length > 0 ? 1 : 0
}

function machine(): Machine {
  const home = homedir()

  return {
    home,
    stateDir: `${process.env.XDG_STATE_HOME ?? `${home}/.local/state`}/guard`,
    has: bin => Bun.which(bin) !== null,
    run: async (argv, cwd) => runCommand(argv, { cwd }),
    read: readText,
    exists: existsSync,
    write: (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    remove: path => rmSync(path, { force: true }),
  }
}

async function hookCommand(args: string[]): Promise<number> {
  const parsed = parse(args, hookUsage, {})

  if (parsed === undefined)
    return 0

  const event = parsed.positionals[0] ?? ''

  // exit 2 would block every call the hook sees, so a wrong event fails like any other error
  if (!EVENTS.includes(event as Event))
    fail(`unknown event ${event}\n\n${hookUsage}`, 1)

  const reply = await hook(event as Event, JSON.parse(await Bun.stdin.text()) as HookInput, machine())

  if (reply !== null)
    console.log(JSON.stringify(reply))

  return 0
}

process.exitCode = await runCli({
  name: 'guard',
  version,
  about: 'the safety rules a Claude Code Bash call is held to, each refusal naming the route',
  commands: {
    check: { run: check, summary: 'check a shell command, printing each broken rule with its route' },
    path: { run: async args => Promise.resolve(path(args)), summary: 'check a path a file tool would open' },
    hook: { run: hookCommand, summary: 'answer a Claude Code hook event, JSON in and out' },
  },
  defaultCommand: 'check',
})
