#!/usr/bin/env -S bun --no-env-file --config=/dev/null

import type { ExitRow } from '@kaynooo/cli-kit'
import type { Host } from './checks'
import type { Listed } from './list'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { activeTheme, badge, badUsage, bar, completionScript, duration, fail, formatDuration, getConfigKey, header, isInteractive, jsonOption, keyValue, mainConfigPath, marked, paint, parse, parseConfigValue, PRESETS, printHeader, printJson, readMainConfig, readUsage, role, runCli, section, setConfigKey, sparkline, summarizeUsage, table, tree, unsetConfigKey, updateMainConfig, usagePath, writeErr } from '@kaynooo/cli-kit'
import { pick } from '@kaynooo/cli-kit/picker'
import { completePath, input, select } from '@kaynooo/cli-kit/prompt'
import { isInstalled, runChecks, TOOLS } from './checks'
import { completionDir, installCompletions, installedBins } from './completions'
import { configReport } from './config-report'
import { main as doctor, printOutcome, printResults } from './doctor'
import { convergeFixes } from './fix'
import { hostHere } from './host'
import { install as installPackages, remove as removePackages } from './install'
import { filterBins, listBins } from './list'

const LIST_USAGE = `cli list [word] [--json]: every bin of the @kaynooo/cli-* packages in one line each, what it does and what it is reached for instead of

A word narrows the list to the bins whose name starts with it, or whose package, summary or "instead of" holds it: \`cli list git\` is the git family.

Each line is read from the bin's own --help, so it says what the installed version does; a bin not installed is listed with the command installing it.`

const LIST_EXITS: ExitRow[] = [[0, 'it printed the list'], [2, 'a usage error']]

const LIST_OPTIONS = {
  json: jsonOption('[{bin, package, installed, synopsis?, summary?, replaces?, examples?}]'),
} as const

function print(listed: readonly Listed[]): void {
  printHeader('cli', `${listed.filter(each => each.installed).length}/${listed.length} installed`)

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

  if (!isInteractive())
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
bash and zsh get one script on stdout to source from ~/.bashrc or ~/.zshrc; --install and --dir are fish's.`

const COMPLETIONS_OPTIONS = {
  install: { type: 'boolean', description: 'write the files to the folder instead of printing them' },
  dir: { type: 'string', short: 'd', description: 'the folder to write to, instead of ~/.cache/fish/kaynooo-cli' },
} as const

export async function completions(args: string[], host: Host = hostHere()): Promise<number> {
  const { values, positionals } = parse(args, COMPLETIONS_USAGE, COMPLETIONS_OPTIONS, { positionals: ['<shell>'], exits: [[0, 'it printed or wrote them'], [2, 'a usage error or a shell without a script']], candidates: { '<shell>': () => ['fish', 'bash', 'zsh'] }, examples: ['cli completions fish', ['cli completions fish --install', 'write one file per bin'], ['source <(cli completions bash)', 'in ~/.bashrc'], ['source <(cli completions zsh)', 'in ~/.zshrc']] })

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

const STATS_USAGE = `cli stats [--since 7d] [--mode <terminal|agent|ci|pipe>] [--json]: how often each bin ran, and the usage errors by the option it did not know

Every bin records each run in ~/.local/state/kaynooo-cli/usage.jsonl: the bin, its command, the flag names it saw (never a value or an argument), the exit code, how long it took, its output mode and the unknown option of a usage error.
The commands whose 90th percentile took a second or more are listed slowest first; failed counts exits other than 0 and 2. Set \`KAYNOOO_CLI_NO_USAGE=1\` to stop recording; \`guard\` never records.`

const SLOW_MS = 1000
const STATS_EXITS: ExitRow[] = [[0, 'it printed the summary'], [2, 'a usage error']]

const STATS_OPTIONS = {
  since: { type: 'string', description: 'only the runs this recent (7d, 12h)' },
  mode: { type: 'string', choices: ['terminal', 'agent', 'ci', 'pipe'] as const, description: 'only the runs in this output mode' },
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

  printHeader('cli', 'config')

  const { dim } = paint(process.stdout)

  console.log(section('config files', undefined, process.stdout))
  console.log(table(report.sources.filter(each => each.kind === 'file').map(each => [each.name, each.status === 'absent' ? dim(each.status) : each.status, dim(each.where)])))
  const variables = report.sources.filter(each => each.kind === 'env' && each.status === 'set')

  console.log(variables.length === 0 ? `\n${dim('no variable set')}` : `\n${section('environment', variables.length, process.stdout)}\n${table(variables.map(each => [each.name, each.value ?? '']))}`)
  console.log(`\nworkspace  ${report.workspace}\ntheme      ${report.theme.preset}${report.theme.sources.length === 0 ? '' : `, from ${report.theme.sources.join(', ')}`}`)

  return 0
}

const CONFIG_GET_USAGE = `cli config get <key> [--json]: reads a key from the unified config file (dotted paths such as out.lines or theme.preset)`
const CONFIG_SET_USAGE = `cli config set <key> <value>: sets a key in ~/.config/kaynooo-cli/config.json(c) (numbers, booleans, null and JSON arrays/objects are parsed)`
const CONFIG_UNSET_USAGE = `cli config unset <key>: removes a key from ~/.config/kaynooo-cli/config.json(c)`
const CONFIG_EDIT_USAGE = `cli config edit: opens ~/.config/kaynooo-cli/config.json(c) in $VISUAL or $EDITOR`
const CONFIG_INIT_USAGE = `cli config init: interactively sets workspace, forge, forgeSsh and theme.preset in ~/.config/kaynooo-cli/config.json(c)`

export function configGet(args: string[], host: Host = hostHere()): number {
  const { values, positionals } = parse(args, CONFIG_GET_USAGE, { json: jsonOption('the raw JSON value') }, { positionals: ['<key>'], exits: [[0, 'printed the value'], [1, 'the key is not set'], [2, 'a usage error']], examples: ['cli config get workspace', 'cli config get out.lines'] })
  const [key] = positionals
  const value = getConfigKey(readMainConfig({ home: host.home, xdg: process.env.XDG_CONFIG_HOME }), key)

  if (value === undefined)
    fail(`${key} is not set`, 1)

  if (values.json === true)
    printJson(value)
  else
    console.log(typeof value === 'string' ? value : JSON.stringify(value))

  return 0
}

export function configSet(args: string[], host: Host = hostHere()): number {
  const { positionals } = parse(args, CONFIG_SET_USAGE, {}, { positionals: ['<key>', '<value>'], exits: [[0, 'wrote the value'], [1, 'config file could not be parsed'], [2, 'a usage error']], examples: ['cli config set workspace ~/Workspace', 'cli config set out.lines 200', 'cli config set theme.preset light'] })
  const [key, raw] = positionals
  const parsed = parseConfigValue(raw)
  let valid = true
  const location = { home: host.home, xdg: process.env.XDG_CONFIG_HOME }
  const ok = updateMainConfig((data) => {
    valid = setConfigKey(data, key, parsed)
  }, location)

  if (!valid)
    badUsage(`invalid config key ${key}`)

  if (!ok)
    fail(`${mainConfigPath(location)} does not parse as a JSON object`, 1)

  console.log(`${key} = ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`)

  return 0
}

export function configUnset(args: string[], host: Host = hostHere()): number {
  const { positionals } = parse(args, CONFIG_UNSET_USAGE, {}, { positionals: ['<key>'], exits: [[0, 'removed the key'], [1, 'key was not set or config file could not be parsed'], [2, 'a usage error']], examples: ['cli config unset out.lines'] })
  const [key] = positionals
  let removed = false
  const location = { home: host.home, xdg: process.env.XDG_CONFIG_HOME }
  const ok = updateMainConfig((data) => {
    removed = unsetConfigKey(data, key)
  }, location)

  if (!ok)
    fail(`${mainConfigPath(location)} does not parse as a JSON object`, 1)

  if (!removed)
    fail(`${key} was not set`, 1)

  console.log(`unset ${key}`)

  return 0
}

export async function configEdit(args: string[], host: Host = hostHere()): Promise<number> {
  parse(args, CONFIG_EDIT_USAGE, {}, { positionals: [], exits: [[0, 'editor exited cleanly'], [1, 'editor exited nonzero'], [2, 'a usage error']], examples: ['cli config edit'] })
  const path = mainConfigPath({ home: host.home, xdg: process.env.XDG_CONFIG_HOME })

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}\n')
  }

  const command = [process.env.VISUAL, process.env.EDITOR].find(value => value !== undefined && value !== '') ?? 'vi'
  const child = Bun.spawn(['sh', '-c', `${command} "$1"`, 'sh', path], { stdio: ['inherit', 'inherit', 'inherit'] })

  return await child.exited === 0 ? 0 : 1
}

export async function configInit(args: string[], host: Host = hostHere()): Promise<number> {
  parse(args, CONFIG_INIT_USAGE, {}, { positionals: [], exits: [[0, 'wrote config'], [1, 'cancelled or config unparseable'], [2, 'a usage error']], examples: ['cli config init'] })
  const location = { home: host.home, xdg: process.env.XDG_CONFIG_HOME }
  const current = readMainConfig(location)
  const currentWorkspace = typeof current.workspace === 'string' ? current.workspace : '~/Workspace'
  const currentForge = typeof current.forge === 'string' ? current.forge : ''
  const currentForgeSsh = typeof current.forgeSsh === 'string' ? current.forgeSsh : ''
  const workspace = await input('workspace folder', { default: currentWorkspace, complete: before => completePath(before, process.cwd(), host.home).filter(path => path.endsWith('/')), hint: 'use `cli config set workspace <path>` off a terminal' })

  if (workspace === undefined)
    return 1

  const forge = await input('forge host or URL (optional)', { default: currentForge, hint: 'use `cli config set forge <host>` off a terminal' })

  if (forge === undefined)
    return 1

  const forgeSsh = await input('forge SSH address (optional)', { default: currentForgeSsh, hint: 'use `cli config set forgeSsh <addr>` off a terminal' })

  if (forgeSsh === undefined)
    return 1

  const preset = await select('theme preset', Object.keys(PRESETS).map(name => ({ value: name, label: name, hint: '' })), { default: 'default', hint: 'use `cli config set theme.preset <name>` off a terminal' })

  if (preset === undefined)
    return 1

  const ok = updateMainConfig((data) => {
    if (workspace !== '')
      data.workspace = workspace

    if (forge !== '')
      data.forge = forge

    if (forgeSsh !== '')
      data.forgeSsh = forgeSsh

    setConfigKey(data, 'theme.preset', preset)
  }, location)

  if (!ok)
    fail(`${mainConfigPath(location)} does not parse as a JSON object`, 1)

  console.log(`wrote ${mainConfigPath(location)}`)

  return 0
}

export async function stats(args: string[], path = usagePath()): Promise<number> {
  const { values } = parse(args, STATS_USAGE, STATS_OPTIONS, { positionals: [], exits: STATS_EXITS, examples: ['cli stats', ['cli stats --since 7d', 'the last week'], ['cli stats --mode agent', 'only runs from coding agents']] })
  const window = values.since === undefined ? undefined : duration(values.since, 'since', 0, 'h')
  const summary = summarizeUsage(await readUsage(path, window === undefined ? 0 : Date.now() - window, values.mode))

  if (values.json === true) {
    printJson(summary)

    return 0
  }

  if (summary.runs === 0) {
    console.log('no run recorded')

    return 0
  }

  printHeader('cli', `stats · ${summary.runs} runs`)
  console.log(`${summary.runs} runs\n\n${table(summary.bins.map(each => [each.bin, String(each.runs), `${each.failed} failed`, `${each.usageErrors} usage errors`]))}`)

  const busy = summary.commands.filter(each => each.failed + each.usageErrors > 0).toSorted((a, b) => b.failed + b.usageErrors - (a.failed + a.usageErrors)).slice(0, 15)

  if (busy.length > 0)
    console.log(`\n${section('commands with failures or usage errors', busy.length, process.stdout)}\n${table(busy.map(each => [`${each.bin} ${each.command}`, String(each.runs), `${each.failed} failed`, `${each.usageErrors} usage errors`]))}`)

  if (summary.usageErrors.length > 0)
    console.log(`\n${section('unknown options', summary.usageErrors.length, process.stdout)}\n${table(summary.usageErrors.map(each => [`${each.bin}${each.command === undefined ? '' : ` ${each.command}`}`, each.unknown, `${each.count}x`]))}`)

  const slow = summary.durations.filter(each => each.p90 >= SLOW_MS).slice(0, 15)

  if (slow.length > 0)
    console.log(`\n${section('slowest commands', slow.length, process.stdout)}\n${table(slow.map(each => [`${each.bin}${each.command === undefined ? '' : ` ${each.command}`}`, `${each.runs} timed`, `median ${formatDuration(each.median)}`, `p90 ${formatDuration(each.p90)}`]))}`)

  return 0
}

const THEME_USAGE = `cli theme [preset]: preview the active theme, or a named preset

Draws the marks, roles, status badges, bar, sparkline and tree with the theme in force (or the preset named: ${Object.keys(PRESETS).join(', ')}).`

const THEME_EXITS: ExitRow[] = [[0, 'it printed the preview'], [2, 'a usage error']]

export function theme(args: string[]): number {
  const { positionals } = parse(args, THEME_USAGE, {}, { positionals: ['[preset]'], exits: THEME_EXITS, candidates: { '[preset]': () => Object.keys(PRESETS) }, examples: ['cli theme', ['cli theme light', 'preview the light preset'], ['cli theme ascii', 'preview the ASCII preset']] })
  const preset = positionals[0]

  if (preset !== undefined && !Object.hasOwn(PRESETS, preset))
    badUsage(`no preset ${preset}, one of ${Object.keys(PRESETS).join(', ')}`)

  const before = process.env.KIT_THEME

  if (preset !== undefined)
    process.env.KIT_THEME = preset

  try {
    const out = process.stdout
    const loaded = activeTheme()
    const head = header('cli', `theme · ${loaded.preset}`, out)

    if (head !== '')
      console.log(head)

    console.log(keyValue([['preset', loaded.preset], ['presets', Object.keys(PRESETS).join(', ')], ['files', loaded.sources.length === 0 ? 'none' : loaded.sources.join(', ')]], { stream: out }))
    console.log(`\n${section('marks & badges', undefined, out)}`)
    console.log((['ok', 'warn', 'problem', 'note', 'plan'] as const).map(mark => marked(mark, mark, out)).join('  '))
    console.log(['success', 'failure', 'running', 'waiting', 'skipped'].map(word => badge(word, out)).join('  '))
    console.log((['accent', 'id', 'path', 'label', 'value'] as const).map(name => role(name, out)(name)).join('  '))
    console.log(`\n${section('charts & tree', undefined, out)}`)
    console.log(`${bar(0.65, { stream: out })}  ${sparkline([1, 3, 2, 5, 8, 4, 9, 6], { stream: out })}`)
    console.log(tree([{ label: 'packages', children: [{ label: 'kit', children: [{ label: 'src' }] }, { label: 'git' }] }], { stream: out }))
  }
  finally {
    if (preset !== undefined) {
      if (before === undefined)
        delete process.env.KIT_THEME
      else
        process.env.KIT_THEME = before
    }
  }

  return 0
}

const ADD_USAGE = `cli add [--list] [--dry-run] [--force] [name...|all]: installs @kaynooo/cli-* packages (or hooks), leaving out any whose required tool is missing unless --force`
const REMOVE_USAGE = `cli remove [--dry-run] <name...>: uninstalls @kaynooo/cli-* packages (or hooks)`
const UPDATE_USAGE = `cli update [--dry-run] [--offline] [--verbose] [--json]: checks and updates installed @kaynooo/cli-* packages, dl-installed commands, dead bin links and shell completions`
const MANAGE_USAGE = `cli manage [--dry-run] [--force]: opens the interactive checklist to install or remove @kaynooo/cli-* packages`

export async function add(args: string[], host: Host = hostHere()): Promise<number> {
  const { values, positionals } = parse(args, ADD_USAGE, {
    'list': { type: 'boolean', description: 'print every package with its installed status' },
    'dry-run': { type: 'boolean', description: 'show what would be installed without running it' },
    'force': { type: 'boolean', description: 'install even when a required system tool is missing' },
  }, { positionals: ['[name...]'], exits: [[0, 'installed or listed'], [1, 'blocked or failed'], [2, 'a usage error']], examples: ['cli add git check', ['cli add --list', 'show all packages and status'], ['cli add all --dry-run', 'preview installing everything']] })

  return installPackages(host, { names: positionals, list: values.list === true, dryRun: values['dry-run'] === true, force: values.force === true }, async checks => doctor(['--fix', ...checks.flatMap(check => ['--only', check])], host))
}

export async function remove(args: string[], host: Host = hostHere()): Promise<number> {
  const { values, positionals } = parse(args, REMOVE_USAGE, {
    'dry-run': { type: 'boolean', description: 'show what would be removed without running it' },
  }, { positionals: ['<name...>'], exits: [[0, 'removed or already absent'], [1, 'removal failed'], [2, 'a usage error']], examples: ['cli remove gloss', ['cli remove --dry-run git', 'preview removal']] })

  return removePackages(host, { names: positionals, dryRun: values['dry-run'] === true })
}

export async function update(args: string[], host: Host = hostHere()): Promise<number> {
  const { values } = parse(args, UPDATE_USAGE, {
    'dry-run': { type: 'boolean', description: 'show what would be updated without running it' },
    'offline': { type: 'boolean', description: 'skip registry and remote release lookups' },
    'verbose': { type: 'boolean', description: 'print every check, including up-to-date packages' },
    'json': jsonOption('[{check, ok, detail, fix?}], as the checks stand after updating; the steps run go to stderr'),
  }, { positionals: [], exits: [[0, 'everything is up to date'], [1, 'an update failed or needs manual action'], [2, 'a usage error']], examples: ['cli update', ['cli update --dry-run', 'preview updates'], ['cli update --verbose', 'show every check']] })

  const installedPkgs = Object.keys(TOOLS)
    .filter(name => isInstalled(host, name))
    .map(name => name.slice(name.indexOf('/') + 1))

  const checks = [
    ...installedPkgs,
    'completions',
    'dead-bins',
    ...values.offline !== true && isInstalled(host, '@kaynooo/cli-dl') ? ['dl-bins'] : [],
  ]

  const dry = values['dry-run'] === true
  const offline = values.offline === true
  const verbose = values.verbose === true
  const json = values.json === true
  const registryCache = new Map<string, string>()
  let results = await runChecks(host, checks, { offline, registryCache })
  const failing = results.filter(result => !result.ok)
  let changed = false

  if (failing.length > 0) {
    if (!json)
      printResults(verbose ? results : failing, { header: verbose, showFix: verbose, showBatch: false })

    const log = json ? writeErr : console.log
    const run = await convergeFixes(host, results, async () => runChecks(host, checks, { offline, registryCache }), { dry, onOutcome: outcome => printOutcome(outcome, log) })

    if (dry) {
      if (json)
        printJson(results)

      return 1
    }

    results = run.results
    changed = run.changed
  }

  if (json) {
    printJson(results)

    return results.every(result => result.ok) ? 0 : 1
  }

  if (verbose) {
    if (changed)
      console.log('\nafter the updates:')

    if (failing.length === 0 || changed)
      printResults(results)

    return results.every(result => result.ok) ? 0 : 1
  }

  const remaining = results.filter(result => !result.ok)

  if (remaining.length > 0) {
    if (changed)
      printResults(remaining, { header: false, showBatch: false })

    return 1
  }

  const warned = results.filter(result => result.warn === true)
  const noun = installedPkgs.length === 1 ? 'package' : 'packages'

  if (warned.length > 0) {
    if (offline)
      console.log(marked('warn', `${installedPkgs.length} ${noun} skipped (--offline); dead-bins and completions up to date`, process.stdout))
    else if (warned.length <= 3)
      printResults(warned, { header: false, showBatch: false })
    else
      console.log(marked('warn', `${warned.length} ${warned.length === 1 ? 'package' : 'packages'} could not reach the registry`, process.stdout))

    return 0
  }

  console.log(marked('ok', installedPkgs.length === 0 ? 'no @kaynooo/cli-* package installed' : `${installedPkgs.length} ${noun} up to date`, process.stdout))

  return 0
}

export async function manage(args: string[], host: Host = hostHere()): Promise<number> {
  const { values } = parse(args, MANAGE_USAGE, {
    'dry-run': { type: 'boolean', description: 'show what would change without running it' },
    'force': { type: 'boolean', description: 'install even when a required system tool is missing' },
  }, { positionals: [], exits: [[0, 'updated install'], [1, 'blocked or failed'], [2, 'a usage error']], examples: ['cli manage'] })

  return installPackages(host, { names: [], list: false, dryRun: values['dry-run'] === true, force: values.force === true }, async checks => doctor(['--fix', ...checks.flatMap(check => ['--only', check])], host))
}

if (import.meta.main) {
  process.exitCode = await runCli({
    name: 'cli',
    about: 'the hub for @kaynooo/cli-* packages: discover, install, update, configure and check them',
    replaces: 'running each bin\'s --help to find the one that fits',
    examples: ['cli list', ['cli list --json', 'with each bin\'s synopsis and examples'], 'cli add git check', 'cli update'],
    defaultCommand: 'find',
    runBare: true,
    commands: {
      add: { summary: 'install @kaynooo/cli-* packages (or hooks) by name or all', run: async args => add(args) },
      remove: { summary: 'uninstall @kaynooo/cli-* packages (or hooks) by name', run: async args => remove(args) },
      update: { summary: 'update installed packages, dl commands and completions', run: async args => update(args) },
      manage: { summary: 'interactively check to install and uncheck to remove packages', run: async args => manage(args) },
      doctor: { summary: 'checks this host\'s install of the bins, one line per check, the command that fixes a failing one beside it', run: async args => doctor(args) },
      find: { summary: 'picks a bin on a terminal and shows its help; the default of a bare cli', run: async args => find(args) },
      list: { summary: 'every bin in one line: what it does and what it is reached for instead of', run: async args => list(args) },
      config: {
        summary: 'show or edit unified config (~/.config/kaynooo-cli/config.jsonc) and active env vars',
        defaultCommand: 'show',
        runBare: true,
        commands: {
          show: { summary: 'where every bin looks for its config and which environment variables are set', run: async args => Promise.resolve(config(args)) },
          get: { summary: 'read a dotted key from config.json(c)', run: async args => Promise.resolve(configGet(args)) },
          set: { summary: 'set a dotted key in config.json(c)', run: async args => Promise.resolve(configSet(args)) },
          unset: { summary: 'remove a dotted key from config.json(c)', run: async args => Promise.resolve(configUnset(args)) },
          edit: { summary: 'open config.json(c) in $VISUAL or $EDITOR', run: async args => configEdit(args) },
          init: { summary: 'interactively set workspace, forge and theme', run: async args => configInit(args) },
        },
        examples: ['cli config', 'cli config get workspace', 'cli config set out.lines 200', 'cli config init'],
      },
      stats: { summary: 'how often each bin ran and the options usage errors did not know', run: async args => stats(args) },
      theme: { summary: 'preview the active theme or a named preset', run: async args => Promise.resolve(theme(args)) },
      completions: { summary: 'shell completions for every installed bin: fish files printed or written to the folder fish reads, a bash or zsh script', run: async args => completions(args) },
    },
  })
}
