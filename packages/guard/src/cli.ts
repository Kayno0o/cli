#!/usr/bin/env bun

import type { Context, Verdict, Violation } from './check'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import process from 'node:process'
import { fail, parse, readInput, runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { checkCommand, checkPath } from './check'

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

process.exitCode = await runCli({
  name: 'guard',
  version,
  about: 'the safety rules a Claude Code Bash call is held to, each refusal naming the route',
  commands: {
    check: { run: check, summary: 'check a shell command, printing each broken rule with its route' },
    path: { run: async args => Promise.resolve(path(args)), summary: 'check a path a file tool would open' },
  },
  defaultCommand: 'check',
})
