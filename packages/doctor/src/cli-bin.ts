#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { Host } from './checks'
import type { Listed } from './list'
import process from 'node:process'
import { badUsage, duration, jsonOption, paint, parse, printJson, readUsage, runCli, summarizeUsage, table, usagePath } from '@kaynooo/cli-kit'
import { bashScript, completionDir, completionFile, installCompletions, installedBins, zshScript } from './completions'
import { configReport } from './config-report'
import { main as doctor } from './doctor'
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

const COMPLETIONS_USAGE = `cli completions <fish|bash|zsh> [--install] [--dir <folder>]: shell completions for every installed bin of the @kaynooo/cli-* packages

Each bin completes itself through \`<bin> __complete\`; this writes the glue a shell needs per bin.
fish: without --install the files print on stdout, with it they go to ~/.cache/fish/kaynooo-cli (or $XDG_CACHE_HOME), one <bin>.fish each, the stale ones this command wrote taken out. That folder has to be in fish_complete_path, first so a completion fish ships for the same name does not win: \`set -p fish_complete_path ~/.cache/fish/kaynooo-cli\`.
bash: one script on stdout, sourced from ~/.bashrc with \`source <(cli completions bash)\`; --install and --dir are fish's.
zsh: one script on stdout like bash's, after compinit in ~/.zshrc: \`autoload -U +X compinit && compinit\`, then \`source <(cli completions zsh)\` (written without zsh at hand to run it, so untested).`

const COMPLETIONS_OPTIONS = {
  install: { type: 'boolean', description: 'write the files to the folder instead of printing them' },
  dir: { type: 'string', short: 'd', description: 'the folder to write to, instead of ~/.cache/fish/kaynooo-cli' },
} as const

export async function completions(args: string[], host: Host = hostHere()): Promise<number> {
  const { values, positionals } = parse(args, COMPLETIONS_USAGE, COMPLETIONS_OPTIONS, { positionals: ['<shell>'], exits: [[0, 'it printed or wrote them'], [2, 'a usage error or a shell without a script']], candidates: { '<shell>': () => ['fish', 'bash', 'zsh'] }, examples: ['cli completions fish', ['cli completions fish --install', 'write one file per bin'], ['source <(cli completions bash)', 'in ~/.bashrc'], ['source <(cli completions zsh)', 'in ~/.zshrc after compinit']] })

  if (positionals[0] !== 'fish' && positionals[0] !== 'bash' && positionals[0] !== 'zsh')
    badUsage('completions exist for fish, bash and zsh: cli completions fish')

  if (positionals[0] === 'bash' || positionals[0] === 'zsh') {
    if (values.install === true || values.dir !== undefined)
      badUsage(`--install and --dir are for fish: source the ${positionals[0]} script instead`)

    console.log((positionals[0] === 'zsh' ? zshScript : bashScript)(installedBins(host)).trimEnd())

    return 0
  }

  if (values.install !== true) {
    console.log(installedBins(host).map(completionFile).join('\n'))

    return 0
  }

  const dir = values.dir ?? completionDir(host.home)
  const { written, removed } = await installCompletions(host, dir)

  console.log(`wrote ${written.length} completions to ${dir}${removed.length === 0 ? '' : `, took out ${removed.join(', ')}`}`)

  return 0
}

const STATS_USAGE = `cli stats [--since 7d] [--json]: how often each bin ran, and the usage errors by the option it did not know

Every bin records each run in ~/.local/state/kaynooo-cli/usage.jsonl (or $XDG_STATE_HOME): the bin, its command, the names of the flags it saw (never a value or an argument), the exit code and and, on a usage error, the unknown option (never the message, which carries the values it refused). failed counts exits other than 0 and 2, usage errors are exit 2 (misuse, or a check that could not be made). Set KAYNOOO_CLI_NO_USAGE=1 to stop recording; \`guard\` never records.
Exits 0 when it printed the summary, 2 on a usage error.`

const STATS_OPTIONS = {
  since: { type: 'string', description: 'only the runs this recent (7d, 12h)' },
  json: jsonOption('{runs, bins: [{bin, runs, failed, usageErrors}], commands: [{bin, command, runs, failed, usageErrors}], usageErrors: [{bin, command?, unknown, count}]}'),
} as const

const CONFIG_USAGE = `cli config [--json]: where every bin looks for its config and which environment variables are set

Lists each user and project config file with the path read and whether it is there (set, absent, or invalid when it does not parse), then the main environment variables that change a bin's behaviour (docs/config.md has the rest); a token or webhook shows as hidden. Ends on the workspace folder and the theme in force. docs/config.md in the repository describes every key.
Exits 0 when it printed the report, 2 on a usage error.`

const CONFIG_OPTIONS = {
  json: jsonOption('{workspace, theme: {preset, sources}, sources: [{kind, name, where, status, value?}]}'),
} as const

export function config(args: string[], host: Host = hostHere()): number {
  const { values } = parse(args, CONFIG_USAGE, CONFIG_OPTIONS, { positionals: [], examples: ['cli config', ['cli config --json', 'for a script']] })
  const report = configReport(host)

  if (values.json === true) {
    printJson(report)

    return 0
  }

  const { dim } = paint(process.stdout)

  console.log(table(report.sources.filter(each => each.kind === 'file').map(each => [each.name, each.status === 'absent' ? dim(each.status) : each.status, dim(each.where)])))
  const variables = report.sources.filter(each => each.kind === 'env' && each.status === 'set')

  console.log(variables.length === 0 ? `\n${dim('no variable set')}` : `\n${table(variables.map(each => [each.name, each.value ?? '']))}`)
  console.log(`\nworkspace  ${report.workspace}\ntheme      ${report.theme.preset}${report.theme.sources.length === 0 ? '' : `, from ${report.theme.sources.join(', ')}`}`)

  return 0
}

export async function stats(args: string[], path = usagePath()): Promise<number> {
  const { values } = parse(args, STATS_USAGE, STATS_OPTIONS, { positionals: [], examples: ['cli stats', ['cli stats --since 7d', 'the last week']] })
  const window = values.since === undefined ? undefined : duration(values.since, 'since', 0, 'h')
  const summary = summarizeUsage(await readUsage(path, window === undefined ? 0 : Date.now() - window))

  if (values.json === true) {
    printJson(summary)

    return 0
  }

  if (summary.runs === 0) {
    console.log('no run recorded')

    return 0
  }

  console.log(`${summary.runs} runs\n\n${table(summary.bins.map(each => [each.bin, String(each.runs), `${each.failed} failed`, `${each.usageErrors} usage errors`]))}`)

  const busy = summary.commands.filter(each => each.failed + each.usageErrors > 0).toSorted((a, b) => b.failed + b.usageErrors - (a.failed + a.usageErrors)).slice(0, 15)

  if (busy.length > 0)
    console.log(`\ncommands with failures or usage errors\n${table(busy.map(each => [`${each.bin} ${each.command}`, String(each.runs), `${each.failed} failed`, `${each.usageErrors} usage errors`]))}`)

  if (summary.usageErrors.length > 0)
    console.log(`\nunknown options\n${table(summary.usageErrors.map(each => [`${each.bin}${each.command === undefined ? '' : ` ${each.command}`}`, each.unknown, `${each.count}x`]))}`)

  return 0
}

if (import.meta.main) {
  process.exitCode = await runCli({
    name: 'cli',
    about: 'the bins of the @kaynooo/cli-* packages, described by their own help',
    replaces: 'running each bin\'s --help to find the one that fits',
    examples: ['cli list', ['cli list --json', 'with each bin\'s synopsis and examples']],
    commands: {
      doctor: { summary: 'checks this host\'s install of the bins, one line per check, the command that fixes a failing one beside it', run: async args => doctor(args) },
      list: { summary: 'every bin in one line: what it does and what it is reached for instead of', run: async args => list(args) },
      config: { summary: 'where every bin looks for its config and which environment variables are set', run: async args => Promise.resolve(config(args)) },
      stats: { summary: 'how often each bin ran and the options usage errors did not know', run: async args => stats(args) },
      completions: { summary: 'fish completions for every installed bin, printed or written to the folder fish reads', run: async args => completions(args) },
    },
  })
}
