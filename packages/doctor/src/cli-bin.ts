#!/usr/bin/env bun

import type { Host } from './checks'
import type { Listed } from './list'
import process from 'node:process'
import { badUsage, jsonOption, paint, parse, printJson, runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { completionDir, completionFile, installCompletions, installedBins } from './completions'
import { hostHere } from './host'
import { listBins } from './list'

const LIST_USAGE = `cli list [--json]: every bin of the @kaynooo/cli-* packages in one line each, what it does and what it is reached for instead of

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
  const { values } = parse(args, LIST_USAGE, LIST_OPTIONS, { positionals: [], examples: ['cli list', ['cli list --json', 'with each bin\'s synopsis and examples']] })
  const listed = await listBins(host)

  if (values.json === true)
    printJson(listed)
  else
    print(listed)

  return 0
}

const COMPLETIONS_USAGE = `cli completions fish [--install] [--dir <folder>]: fish completions for every installed bin of the @kaynooo/cli-* packages

Each bin completes itself through \`<bin> __complete\`; this writes the one line fish needs per bin. Without --install the files print on stdout, with it they go to ~/.cache/fish/kaynooo-cli (or $XDG_CACHE_HOME), one <bin>.fish each, the stale ones this command wrote taken out. That folder has to be in fish_complete_path, first so a completion fish ships for the same name does not win: \`set -p fish_complete_path ~/.cache/fish/kaynooo-cli\`.
Exits 0 when it printed or wrote them, 2 on a usage error.`

const COMPLETIONS_OPTIONS = {
  install: { type: 'boolean', description: 'write the files to the folder instead of printing them' },
  dir: { type: 'string', short: 'd', description: 'the folder to write to, instead of ~/.cache/fish/kaynooo-cli' },
} as const

export async function completions(args: string[], host: Host = hostHere()): Promise<number> {
  const { values, positionals } = parse(args, COMPLETIONS_USAGE, COMPLETIONS_OPTIONS, { positionals: ['<shell>'], candidates: { '<shell>': () => ['fish'] }, examples: ['cli completions fish', ['cli completions fish --install', 'write one file per bin']] })

  if (positionals[0] !== 'fish')
    badUsage('only fish is supported: cli completions fish')

  if (values.install !== true) {
    console.log(installedBins(host).map(completionFile).join('\n'))

    return 0
  }

  const dir = values.dir ?? completionDir(host.home)
  const { written, removed } = await installCompletions(host, dir)

  console.log(`wrote ${written.length} completions to ${dir}${removed.length === 0 ? '' : `, took out ${removed.join(', ')}`}`)

  return 0
}

if (import.meta.main) {
  process.exitCode = await runCli({
    name: 'cli',
    version,
    about: 'the bins of the @kaynooo/cli-* packages, described by their own help',
    replaces: 'running each bin\'s --help to find the one that fits',
    examples: ['cli list', ['cli list --json', 'with each bin\'s synopsis and examples']],
    commands: {
      list: { summary: 'every bin in one line: what it does and what it is reached for instead of', run: async args => list(args) },
      completions: { summary: 'fish completions for every installed bin, printed or written to the folder fish reads', run: async args => completions(args) },
    },
  })
}
