#!/usr/bin/env bun

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Host, Result } from './checks'
import type { Outcome } from './fix'
import process from 'node:process'
import { jsonOption, paint, parse, printJson, runMain } from '@kaynooo/cli-kit'
import { CHECK_NAMES, runChecks } from './checks'
import { applyFixes, planFixes } from './fix'
import { hostHere } from './host'

const USAGE = `doctor [--only <check>] [--quiet] [--fix [--dry-run]] [--json]: checks this host's @kaynooo/cli-* install, one line per check, the command that fixes a failing one beside it

Each @kaynooo/cli-* package installed globally with its bins on the PATH and no older than the registry's latest; tea logged in to git.kaynooo.fr and reaching it; the Claude Code hooks wired through the cli-hooks plugin or the cli mod, not both; Bun at least the version the tools ask for; fish completions for every bin.
--fix runs the printed fix: lines it may (global installs of the packages, the completions, the hooks plugin), the installs in one call, then checks again; a line that installs a system package or only describes a step is printed as not run. --dry-run shows what --fix would run.
--quiet prints only the failing checks, nothing when all pass. --only limits the run to the checks named, e.g. --only tea --only bun.`

const EXITS: ExitRow[] = [[0, 'every check passes (after --fix, the ones it fixed too)'], [1, 'a check fails'], [2, 'a usage error']]

const INSTALL = 'bun install -g '

const OPTIONS = {
  'json': jsonOption('[{check, ok, detail, fix?}], as the checks stand after --fix; the fixes it ran go to stderr'),
  'only': { type: 'string', multiple: true, choices: CHECK_NAMES, description: 'run only this check (a package such as cli-forgejo, tea, hooks, bun or completions), repeatable' },
  'quiet': { type: 'boolean', short: 'q', description: 'print only the failing checks' },
  'fix': { type: 'boolean', description: 'run the fix: lines doctor may run, then check again' },
  'dry-run': { type: 'boolean', description: 'with --fix, show what would run without running it (alone, it implies --fix)' },
} as const

function print(results: readonly Result[]): void {
  if (results.length === 0)
    return

  const { green, red, dim } = paint(process.stdout)
  const width = Math.max(...results.map(result => result.check.length))

  for (const { check, ok, detail, fix } of results)
    console.log(`${ok ? green('ok  ') : red('FAIL')}  ${check.padEnd(width)}  ${detail}${fix === undefined ? '' : `  ${dim('fix:')} ${fix}`}`)

  const installs = results.flatMap(result => result.fix?.startsWith(INSTALL) === true ? [result.fix.slice(INSTALL.length)] : [])

  if (installs.length > 1)
    console.log(`\n${dim('fix them all:')} ${INSTALL}${installs.join(' ')}`)
}

function printOutcomes(outcomes: readonly Outcome[], log: (line: string) => void): void {
  const { green, red, dim } = paint(process.stdout)
  const marks = { 'ran': green('ran    '), 'failed': red('failed '), 'dry-run': dim('would  '), 'not run': dim('not run') }

  for (const { command, status, detail } of outcomes)
    log(`${marks[status]}  ${command}${detail === undefined ? '' : `  ${dim(detail)}`}`)
}

export async function main(args: string[], host: Host = hostHere()): Promise<number> {
  const { values } = parse(args, USAGE, OPTIONS, { positionals: [], exits: EXITS, replaces: 'checking each bin\'s version, tea\'s login and the hooks by hand', examples: ['doctor', ['doctor --json', 'the checks for a script'], ['doctor -q', 'silent unless something fails'], ['doctor --fix --dry-run', 'what --fix would run']] })
  const only = values.only ?? []
  const dry = values['dry-run'] === true
  const json = values.json === true
  let results = await runChecks(host, only)
  let fixed = false

  if ((values.fix === true || dry) && results.some(result => !result.ok)) {
    if (!json)
      print(values.quiet === true ? results.filter(result => !result.ok) : results)

    const steps = planFixes(results)

    printOutcomes(await applyFixes(host, steps, dry), json ? console.error : console.log)

    if (dry)
      return 1

    results = await runChecks(host, only)

    fixed = true
  }

  const shown = values.quiet === true ? results.filter(result => !result.ok) : results

  if (fixed && !json && shown.length > 0)
    console.log('\nafter the fixes:')

  if (json)
    printJson(shown)
  else
    print(shown)

  return results.every(result => result.ok) ? 0 : 1
}

if (import.meta.main)
  process.exitCode = await runMain({ name: 'doctor', run: async args => main(args) })
