#!/usr/bin/env bun

import type { Host } from './checks'
import type { Listed } from './list'
import process from 'node:process'
import { jsonOption, paint, parse, printJson, runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { hostHere } from './host'
import { listBins } from './list'

const LIST_USAGE = `agent-tools list [--json]: every agent-tools bin in one line each, what it does and what it is reached for instead of

Each line is read from the bin's own --help, so it says what the installed version does; a bin not installed is listed with the command installing it.
Exits 0 when it printed the list, 2 on a usage error.`

const LIST_OPTIONS = {
  json: jsonOption('[{bin, package, installed, synopsis?, summary?, replaces?, examples?}]'),
} as const

function print(listed: readonly Listed[]): void {
  const { cyan, dim } = paint(process.stdout)
  const width = Math.max(...listed.map(each => each.bin.length))

  for (const each of listed) {
    const what = !each.installed ? dim(`not installed: bun install -g ${each.package}`) : `${each.summary ?? ''}${each.replaces === undefined ? '' : dim(`; instead of ${each.replaces}`)}`

    console.log(`${cyan(each.bin.padEnd(width))}  ${what}`)
  }
}

export async function list(args: string[], host: Host = hostHere()): Promise<number> {
  const { values } = parse(args, LIST_USAGE, LIST_OPTIONS, { positionals: [], examples: ['agent-tools list', ['agent-tools list --json', 'with each bin\'s synopsis and examples']] })
  const listed = await listBins(host)

  if (values.json === true)
    printJson(listed)
  else
    print(listed)

  return 0
}

if (import.meta.main) {
  process.exitCode = await runCli({
    name: 'agent-tools',
    version,
    about: 'the agent-tools bins, described by their own help',
    replaces: 'running each bin\'s --help to find the one that fits',
    examples: ['agent-tools list', ['agent-tools list --json', 'with each bin\'s synopsis and examples']],
    commands: {
      list: { summary: 'every bin in one line: what it does and what it is reached for instead of', run: async args => list(args) },
    },
  })
}
