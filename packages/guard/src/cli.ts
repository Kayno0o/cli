#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Context, Verdict, Violation } from './check'
import type { Event, HookInput, Machine } from './hook'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, parse, printJson, readInput, role, runCli, runCommand, stateHome } from '@kaynooo/cli-kit'
import { checkCommand, checkPath } from './check'
import { commandPrintsTrackedEnv, EVENTS, hook } from './hook'
import { RULES } from './rules'

const checkUsage = `guard check [options] [<command> | -]: checks a shell command against the rules and names the route to take instead of each one it breaks

The rules (\`guard rules\` lists them) cover remote machines, git, destructive commands, commit messages, SQL writes, env files, package managers and in-place edits. A clean command prints nothing and exits 0.
The command is read from stdin with - or when none is given; a rule may rewrite it instead, printed as \`runs as: <command>\`.`

const CHECK_EXITS: ExitRow[] = [[0, 'the command is clean'], [1, 'a rule is broken'], [2, 'a usage error']]

const checkOptions = {
  'json': jsonOption('{violations, command, notes, packages} for a hook'),
  'format': { type: 'string', choices: ['text', 'json', 'claude', 'generic'] as const, description: 'output format: text (default), json, claude (PreToolUse JSON) or generic ({allow, violations, command})' },
  'cwd': { type: 'string', description: 'the directory the command runs in (default: here)' },
  'push-asked': { type: 'boolean', description: 'the user asked for a push, so git push may run' },
  'pkg': { type: 'boolean', negative: 'skip running pkg check on packages the command adds' },
  'wrap': { type: 'boolean', negative: 'never route a noisy command through out' },
} as const

const pathUsage = `guard path [--json] <path>...

Checks the paths a file tool would read, edit or write: env files are refused.`

const PATH_EXITS: ExitRow[] = [[0, 'every path is clean'], [1, 'one is refused'], [2, 'a usage error']]

const pathOptions = {
  json: jsonOption('{violations} for a hook'),
} as const

const hookUsage = `guard hook <${EVENTS.join('|')}>

Answers a Claude Code hook: reads the event JSON on stdin and prints the reply JSON, nothing when the call goes ahead untouched.
\`pre-tool-use\` refuses a Bash call breaking a rule, an install \`pkg\` refuses and a file tool reaching an env file; \`user-prompt-submit\` remembers whether the prompt asked for a push; \`session-start\` lists the installed bins.
A failure exits 1, which Claude Code reports without blocking the call.`

const HOOK_EXITS: ExitRow[] = [[0, 'it answered'], [1, 'a failure or an unknown event (never 2, which would block the call)']]

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
    console.log(`${role('problem', process.stdout)(rule)}: ${message}`)
}

async function check(args: string[]): Promise<number> {
  const parsed = parse(args, checkUsage, checkOptions, { exits: CHECK_EXITS, allowNegative: true })

  const { values, positionals } = parsed

  if (positionals.length > 1)
    fail(`give the command as one argument, quoted\n\n${checkUsage}`)

  const given = positionals[0] ?? '-'
  const command = given === '-' ? await readInput('-', { noStdin: 'give the command, or pipe it on stdin' }) : given
  const cwd = values.cwd ?? process.cwd()
  const run = async (argv: string[], dir: string) => runCommand(argv, { cwd: dir })
  const context: Context = {
    cwd,
    home: homedir(),
    isPushAsked: values['push-asked'] === true,
    canRewrite: true,
    canWrap: values.wrap !== false && Bun.which('out') !== null,
    canSub: Bun.which('sub') !== null,
    read: readText,
    exists: existsSync,
    hasTrackedEnv: await commandPrintsTrackedEnv(command, cwd, run),
  }
  const verdict: Verdict = await checkCommand(command, context)

  if (verdict.violations.length === 0 && verdict.packages.length > 0 && values.pkg !== false && Bun.which('pkg') !== null) {
    const checked = await run(['pkg', 'check', ...verdict.packages], cwd)

    if (checked.code !== 0) {
      const message = checked.code === 1 ? 'pkg refused what this adds, so it was not run' : `pkg check failed (exit ${checked.code}), so what this adds was not checked and it was not run`

      verdict.violations.push({ rule: 'pkg', message: `${message}:\n${checked.text.trim()}` })
    }
  }

  const format = values.format ?? (values.json === true ? 'json' : 'text')

  if (format === 'json') {
    printJson(verdict)
  }
  else if (format === 'claude') {
    if (verdict.violations.length > 0)
      printJson({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.violations.map(each => each.message).join('\n\n') } })
  }
  else if (format === 'generic') {
    printJson({ allow: verdict.violations.length === 0, violations: verdict.violations, command: verdict.command, notes: verdict.notes, packages: verdict.packages })
  }
  else {
    report(verdict.violations)

    if (verdict.command !== command)
      console.log(`${role('label', process.stdout)('runs as:')} ${verdict.command}${verdict.notes.map(note => `\n${note}`).join('')}`)
  }

  return verdict.violations.length > 0 ? 1 : 0
}

function path(args: string[]): number {
  const parsed = parse(args, pathUsage, pathOptions, { exits: PATH_EXITS })

  if (parsed.positionals.length === 0)
    fail(`give at least one path\n\n${pathUsage}`)

  const violations = parsed.positionals.flatMap(each => checkPath(each) ?? [])

  if (parsed.values.json === true)
    printJson({ violations })
  else
    report(violations)

  return violations.length > 0 ? 1 : 0
}

const rulesUsage = `guard rules [--json]

Lists every rule \`guard check\` and \`guard hook\` apply: its name as a violation carries it, what it refuses, the route its refusal points at and where it runs.`

const RULES_EXITS: ExitRow[] = [[0, 'it listed them']]

const rulesOptions = {
  json: jsonOption('[{name, refuses, route, runs}]'),
} as const

function rules(args: string[]): number {
  const parsed = parse(args, rulesUsage, rulesOptions, { exits: RULES_EXITS })

  if (parsed.values.json === true) {
    printJson(RULES)

    return 0
  }

  for (const rule of RULES)
    // Not padEnd: the colour codes of the name would count in the width.
    console.log(`${role('id', process.stdout)(rule.name)}${' '.repeat(Math.max(0, 16 - rule.name.length))} ${rule.refuses}\n${' '.repeat(16)} -> ${rule.route}${rule.runs === 'hook' ? ' (hook only)' : ''}`)

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
  const parsed = parse(args, hookUsage, {}, { exits: HOOK_EXITS, positionals: ['[event]'], candidates: { '[event]': () => [...EVENTS] } })

  const event = parsed.positionals[0] ?? ''

  // exit 2 would block every call the hook sees, so a wrong event fails like any other error
  if (!EVENTS.includes(event as Event))
    fail(`unknown event ${event}\n\n${hookUsage}`, 1)

  const raw = (await Bun.stdin.text()).trim()

  if (raw === '')
    fail('hook event stdin is empty', 1)

  let input: HookInput

  try {
    const parsedInput: unknown = JSON.parse(raw)

    if (typeof parsedInput !== 'object' || parsedInput === null || Array.isArray(parsedInput))
      fail('hook event stdin must be a JSON object', 1)

    input = parsedInput
  }
  catch (error) {
    fail(`invalid hook event JSON: ${error instanceof Error ? error.message : String(error)}`, 1)
  }

  const reply = await hook(event as Event, input, machine())

  if (reply !== null)
    console.log(JSON.stringify(reply))

  return 0
}

process.exitCode = await runCli({
  name: 'guard',
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
