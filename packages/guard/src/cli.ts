#!/usr/bin/env bun

import type { Context, Verdict, Violation } from './check'
import type { Event, HookInput, Machine } from './hook'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, parse, readInput, runCli, runCommand, stateHome } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { checkCommand, checkPath } from './check'
import { EVENTS, hook } from './hook'
import { RULES } from './rules'

const checkUsage = `guard check [options] [<command> | -]

Checks a shell command against the rules: remote machines, git (stash, whole-tree add and commit, push, tags), destructive commands (reset --hard, force push, rebase, broad rm), commit messages, SQL writes, env files, package managers and in-place edits (sed -i and replace scripts, pointed at sub).
Prints each broken rule with the route to take instead and exits 1, prints nothing and exits 0 when the command is clean.
The command is read from stdin with - or when none is given; a rule may rewrite it instead (the pinned package manager, a noisy run through out), printed as \`runs as: <command>\`.

Exits 0 when the command is clean, 1 when a rule is broken, 2 on a usage error.`

const checkOptions = {
  'json': jsonOption('{violations, command, notes, packages} for a hook'),
  'cwd': { type: 'string', description: 'the directory the command runs in (default: here)' },
  'push-asked': { type: 'boolean', description: 'the user asked for a push, so git push may run' },
  'no-wrap': { type: 'boolean', description: 'never route a noisy command through out' },
} as const

const pathUsage = `guard path [--json] <path>...

Checks the paths a file tool would read, edit or write: env files are refused.

Exits 0 when every path is clean, 1 when one is refused, 2 on a usage error.`

const pathOptions = {
  json: jsonOption('{violations} for a hook'),
} as const

const hookUsage = `guard hook <${EVENTS.join('|')}>

Answers a Claude Code hook: reads the event JSON on stdin and prints the reply JSON, nothing when the call goes ahead untouched.
pre-tool-use refuses a Bash call breaking a rule, an install pkg refuses (or fails to check), and a file tool (Read, Edit, MultiEdit, Write, NotebookEdit, Grep, Glob) reaching an env file; user-prompt-submit remembers whether the prompt asked for a push; session-start lists the installed @kaynooo/cli-* bins.
A failure exits 1, which Claude Code reports without blocking the call.

Exits 0 when it answered, 1 on a failure or an unknown event (never 2, which would block the call).`

const MAX_READ = 1_000_000

// A regular file of a sane size only: a device such as /dev/zero would hang the hook.
function readText(path: string): string | null {
  try {
    const stats = statSync(path, { throwIfNoEntry: false })

    return stats?.isFile() === true && stats.size <= MAX_READ ? readFileSync(path, 'utf8') : null
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
    canSub: Bun.which('sub') !== null,
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

  if (parsed.positionals.length === 0)
    fail(`give at least one path\n\n${pathUsage}`)

  const violations = parsed.positionals.flatMap(each => checkPath(each) ?? [])

  if (parsed.values.json === true)
    console.log(JSON.stringify({ violations }))
  else
    report(violations)

  return violations.length > 0 ? 1 : 0
}

const rulesUsage = `guard rules [--json]

Lists every rule \`guard check\` and \`guard hook\` apply: its name as a violation carries it, what it refuses, the route its refusal points at and where it runs.

Exits 0 once it listed them.`

const rulesOptions = {
  json: jsonOption('[{name, refuses, route, runs}]'),
} as const

function rules(args: string[]): number {
  const parsed = parse(args, rulesUsage, rulesOptions)

  if (parsed.values.json === true) {
    console.log(JSON.stringify(RULES))

    return 0
  }

  for (const rule of RULES)
    console.log(`${rule.name.padEnd(16)} ${rule.refuses}\n${' '.repeat(16)} -> ${rule.route}${rule.runs === 'hook' ? ' (hook only)' : ''}`)

  return 0
}

function machine(): Machine {
  const home = homedir()
  const stateDir = `${stateHome()}/guard`

  return {
    home,
    stateDir,
    has: bin => Bun.which(bin) !== null,
    run: async (argv, cwd) => runCommand(argv, { cwd }),
    read: readText,
    exists: existsSync,
    write: (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    },
    remove: path => rmSync(path, { force: true }),
    log: (text) => {
      try {
        mkdirSync(stateDir, { recursive: true })
        appendFileSync(`${stateDir}/errors.log`, text)
      }
      catch {
        // the log is a courtesy: the refusal stands without it
      }
    },
  }
}

async function hookCommand(args: string[]): Promise<number> {
  const parsed = parse(args, hookUsage, {})

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
  usage: false,
  about: 'the safety rules a Claude Code Bash call is held to, each refusal naming the route',
  replaces: 'a hook script per rule, each wording its own refusal',
  examples: [['guard check "git push --force"', 'the rules a command breaks, with their routes'], ['guard path .env', 'whether a file tool may open a path']],
  commands: {
    check: { run: check, summary: 'check a shell command, printing each broken rule with its route' },
    path: { run: async args => Promise.resolve(path(args)), summary: 'check a path a file tool would open' },
    rules: { run: async args => Promise.resolve(rules(args)), summary: 'list every rule with what it refuses and its route' },
    hook: { run: hookCommand, summary: 'answer a Claude Code hook event, JSON in and out' },
  },
  defaultCommand: 'check',
})
