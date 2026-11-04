#!/usr/bin/env bun

import type { Host, Result } from './checks'
import process from 'node:process'
import { jsonOption, paint, parse, printJson, runMain } from '@kaynooo/cli-kit'
import { runChecks } from './checks'
import { hostHere } from './host'

const USAGE = `doctor [--json]: checks this host's @kaynooo/cli-* install, one line per check, the command that fixes a failing one beside it

Each @kaynooo/cli-* package installed globally with its bins on the PATH and no older than the registry's latest; tea logged in to git.kaynooo.fr and reaching it; the Claude Code hooks wired through the cli-hooks plugin or the cli mod, not both; Bun at least the version the tools ask for.
Exits 0 when every check passes, 1 when one fails, 2 on a usage error.`

const INSTALL = 'bun install -g '

const OPTIONS = {
  json: jsonOption('[{check, ok, detail, fix?}]'),
} as const

function print(results: readonly Result[]): void {
  const { green, red, dim } = paint(process.stdout)
  const width = Math.max(...results.map(result => result.check.length))

  for (const { check, ok, detail, fix } of results)
    console.log(`${ok ? green('ok  ') : red('FAIL')}  ${check.padEnd(width)}  ${detail}${fix === undefined ? '' : `  ${dim('fix:')} ${fix}`}`)

  const installs = results.flatMap(result => result.fix?.startsWith(INSTALL) === true ? [result.fix.slice(INSTALL.length)] : [])

  if (installs.length > 1)
    console.log(`\n${dim('fix them all:')} ${INSTALL}${installs.join(' ')}`)
}

export async function main(args: string[], host: Host = hostHere()): Promise<number> {
  const { values } = parse(args, USAGE, OPTIONS, { positionals: [], replaces: 'checking each bin\'s version, tea\'s login and the hooks by hand', examples: ['doctor', ['doctor --json', 'the checks for a script']] })
  const results = await runChecks(host)

  if (values.json === true)
    printJson(results)
  else
    print(results)

  return results.every(result => result.ok) ? 0 : 1
}

if (import.meta.main)
  process.exitCode = await runMain({ name: 'doctor', run: async args => main(args) })
