#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Host } from './checks'
import type { Listed } from './list'
import process from 'node:process'
import { badUsage, completionScript, duration, formatDuration, jsonOption, paint, parse, printJson, readUsage, runCli, summarizeUsage, table, usagePath } from '@kaynooo/cli-kit'
import { pick } from '@kaynooo/cli-kit/picker'
import { completionDir, installCompletions, installedBins } from './completions'
import { configReport } from './config-report'
import { main as doctor } from './doctor'
import { hostHere } from './host'
import { filterBins, listBins } from './list'

const LIST_USAGE = `cli list [word] [--json]: every bin of the @kaynooo/cli-* packages in one line each, what it does and what it is reached for instead of

A word narrows the list to the bins whose name starts with it, or whose package, summary or "instead of" holds it: \`cli list git\` is the git family.

Each line is read from the bin's own --help, so it says what the installed version does; a bin not installed is listed with the command installing it.`

const LIST_EXITS: ExitRow[] = [[0, 'it printed the list'], [2, 'a usage error']]

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
  const { values, positionals } = parse(args, LIST_USAGE, LIST_OPTIONS, { positionals: ['[word]'], exits: LIST_EXITS, examples: ['cli list', ['cli list git', 'the git family'], ['cli list --json', 'with each bin\'s synopsis and examples']] })
  const listed = filterBins(await listBins(host), positionals[0])

  if (listed.length === 0)
    badUsage(`no bin matches ${positionals[0]}: cli list shows them all`)

  if (values.json === true)
    printJson(listed)
  else
    print(listed)

  return 0
}

const FIND_USAGE = `cli find [word]: picks a bin on a terminal and shows its help; elsewhere it lists them as cli list does

The default of a bare \`cli\`. The picker searches the name first, then what each bin does; the preview below is the bin's own --help, enter prints it in full. A word narrows the rows as in cli list.`

const FIND_EXITS: ExitRow[] = [[0, 'it showed a help or the list'], [1, 'nothing was picked'], [2, 'a usage error']]

async function find(args: string[], host: Host = hostHere()): Promise<number> {
  const { positionals } = parse(args, FIND_USAGE, {}, { positionals: ['[word]'], exits: FIND_EXITS, examples: ['cli', ['cli find git', 'pick among the git family']] })

  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true)
    return list(positionals.filter(word => word !== undefined), host)

  const { cyan, dim } = paint(process.stderr)
  const listed = filterBins(await listBins(host), positionals[0]).filter(each => each.installed)

  if (listed.length === 0)
    badUsage(`no installed bin matches ${positionals[0] ?? ''}: cli list shows them all`)

  const picked = await pick(listed.map(each => ({ hidden: [each.bin], cells: [cyan(each.bin), `${each.summary ?? ''}${each.replaces === undefined ? '' : dim(`; instead of ${each.replaces}`)}`] })), { prompt: 'bin> ', searched: 2, preview: '{1} --help' })

  if (picked === undefined)
    return 1

  const bin = picked.hidden[0] ?? ''
  const shown = Bun.spawnSync([bin, '--help'], { stdout: 'inherit', stderr: 'inherit' })

  return shown.exitCode
}

const COMPLETIONS_USAGE = `cli completions <fish|bash|zsh> [--install] [--dir <folder>]: shell completions for every installed bin of the @kaynooo/cli-* packages

Writes the script of every bin at once. fish gets one file per bin in ~/.cache/fish/kaynooo-cli (or $XDG_CACHE_HOME) with --install, the stale ones it wrote taken out; put that folder first in fish_complete_path.
bash and zsh get one script on stdout to source from ~/.bashrc or ~/.zshrc (after compinit); --install and --dir are fish's.`

const COMPLETIONS_OPTIONS = {
  install: { type: 'boolean', description: 'write the files to the folder instead of printing them' },
  dir: { type: 'string', short: 'd', description: 'the folder to write to, instead of ~/.cache/fish/kaynooo-cli' },
} as const

export async function completions(args: string[], host: Host = hostHere()): Promise<number> {
  const { values, positionals } = parse(args, COMPLETIONS_USAGE, COMPLETIONS_OPTIONS, { positionals: ['<shell>'], exits: [[0, 'it printed or wrote them'], [2, 'a usage error or a shell without a script']], candidates: { '<shell>': () => ['fish', 'bash', 'zsh'] }, examples: ['cli completions fish', ['cli completions fish --install', 'write one file per bin'], ['source <(cli completions bash)', 'in ~/.bashrc'], ['source <(cli completions zsh)', 'in ~/.zshrc after compinit']] })

  if (positionals[0] !== 'fish' && positionals[0] !== 'bash' && positionals[0] !== 'zsh')
    badUsage('completions exist for fish, bash and zsh: cli completions fish')

  if (positionals[0] !== 'fish' && (values.install === true || values.dir !== undefined))
    badUsage(`--install and --dir are for fish: source the ${positionals[0]} script instead`)

  if (values.install !== true) {
    console.log(completionScript(positionals[0], installedBins(host), `# Generated by \`cli completions ${positionals[0]}\``).trimEnd())

    return 0
  }

  const dir = values.dir ?? completionDir(host.home)
  const { written, removed } = await installCompletions(host, dir)

  console.log(`wrote ${written.length} completions to ${dir}${removed.length === 0 ? '' : `, took out ${removed.join(', ')}`}`)

  return 0
}

const STATS_USAGE = `cli stats [--since 7d] [--json]: how often each bin ran, and the usage errors by the option it did not know

Every bin records each run in ~/.local/state/kaynooo-cli/usage.jsonl: the bin, its command, the flag names it saw (never a value or an argument), the exit code, how long it took and the unknown option of a usage error.
The commands whose 90th percentile took a second or more are listed slowest first; failed counts exits other than 0 and 2. Set \`KAYNOOO_CLI_NO_USAGE=1\` to stop recording; \`guard\` never records.`

const SLOW_MS = 1000
const STATS_EXITS: ExitRow[] = [[0, 'it printed the summary'], [2, 'a usage error']]

const STATS_OPTIONS = {
  since: { type: 'string', description: 'only the runs this recent (7d, 12h)' },
  json: jsonOption('{runs, bins: [{bin, runs, failed, usageErrors}], commands: [{bin, command, runs, failed, usageErrors}], usageErrors: [{bin, command?, unknown, count}], durations: [{bin, command?, runs, median, p90}] in ms, slowest p90 first}'),
} as const

const CONFIG_USAGE = `cli config [--json]: where every bin looks for its config and which environment variables are set

Lists each user and project config file with the path read and whether it is there (set, absent, or invalid when it does not parse), then the main environment variables that change a bin's behaviour (docs/config.md has the rest); a token or webhook shows as hidden. Ends on the workspace folder and the theme in force. docs/config.md in the repository describes every key.`

const CONFIG_EXITS: ExitRow[] = [[0, 'it printed the report'], [2, 'a usage error']]

const CONFIG_OPTIONS = {
  json: jsonOption('{workspace, theme: {preset, sources}, sources: [{kind, name, where, status, value?}]}'),
} as const

export function config(args: string[], host: Host = hostHere()): number {
  const { values } = parse(args, CONFIG_USAGE, CONFIG_OPTIONS, { positionals: [], exits: CONFIG_EXITS, examples: ['cli config', ['cli config --json', 'for a script']] })
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
  const { values } = parse(args, STATS_USAGE, STATS_OPTIONS, { positionals: [], exits: STATS_EXITS, examples: ['cli stats', ['cli stats --since 7d', 'the last week']] })
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

  const slow = summary.durations.filter(each => each.p90 >= SLOW_MS).slice(0, 15)

  if (slow.length > 0)
    console.log(`\nslowest commands\n${table(slow.map(each => [`${each.bin}${each.command === undefined ? '' : ` ${each.command}`}`, `${each.runs} timed`, `median ${formatDuration(each.median)}`, `p90 ${formatDuration(each.p90)}`]))}`)

  return 0
}

if (import.meta.main) {
  process.exitCode = await runCli({
    name: 'cli',
    about: 'the bins of the @kaynooo/cli-* packages, described by their own help',
    replaces: 'running each bin\'s --help to find the one that fits',
    examples: ['cli list', ['cli list --json', 'with each bin\'s synopsis and examples']],
    defaultCommand: 'find',
    runBare: true,
    commands: {
      doctor: { summary: 'checks this host\'s install of the bins, one line per check, the command that fixes a failing one beside it', run: async args => doctor(args) },
      find: { summary: 'picks a bin on a terminal and shows its help; the default of a bare cli', run: async args => find(args) },
      list: { summary: 'every bin in one line: what it does and what it is reached for instead of', run: async args => list(args) },
      config: { summary: 'where every bin looks for its config and which environment variables are set', run: async args => Promise.resolve(config(args)) },
      stats: { summary: 'how often each bin ran and the options usage errors did not know', run: async args => stats(args) },
      completions: { summary: 'shell completions for every installed bin: fish files printed or written to the folder fish reads, a bash or zsh script', run: async args => completions(args) },
    },
  })
}
