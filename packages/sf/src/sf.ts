import type { ExitRow } from '@kaynooo/cli-kit'
import type { Service as ComposeService } from '@kaynooo/cli-kit/compose'
import type { Row } from '@kaynooo/cli-kit/picker'
import type { Arg } from '@kaynooo/cli-kit/term-pick'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { cacheFolder, captureOutput, fail, ignoredFolders, isInteractive, paint, parse, printJson, readUserConfig } from '@kaynooo/cli-kit'
import { findComposeDir, readServices } from '@kaynooo/cli-kit/compose'
import { byRecency, pick, record, runs, table } from '@kaynooo/cli-kit/picker'
import { input } from '@kaynooo/cli-kit/prompt'
import { emit, list } from '@kaynooo/cli-kit/term-pick'

interface Argument {
  name: string
  is_required: boolean
  is_array: boolean
  description: string
}

interface Option {
  name: string
  shortcut: string
  accept_value: boolean
  description: string
}

/** A command as `bin/console list --format=json` describes it, a definition without arguments or options holding an empty array instead of an object. */
export interface Command {
  name: string
  description: string
  help: string
  usage: string[]
  hidden: boolean
  definition: { arguments: Record<string, Argument> | [], options: Record<string, Option> | [] }
}

/** One console, and how its commands are run and listed. */
export interface Console {
  dir: string
  run: string[]
  list: { argv: string[], cwd: string, env: Record<string, string | undefined> }
}

export interface Entry {
  app: Console
  command: Command
}

const usage = `sf [--service <name>] [command] [args...]
sf -

Picks a Symfony console command on a terminal and runs it, asking for each required argument; without a terminal (a script, a pipe, an agent) it lists the commands, the form to use there.
The console is the nearest \`bin/console\` up to the repository root, then those of the child folders (keyed \`api/cache:clear\`), run in the auto-detected or configured PHP compose service when there is one, else with local php.
\`sf -\` runs the last command again with its arguments, \`sf <command> [args...]\` runs without the picker, a name the list does not hold going to the console as is.`

const EXITS: ExitRow[] = [['the code of the console', 'a command it ran'], [0, 'it listed the commands'], [1, 'no bin/console here, or it listed no command'], [2, 'a usage error']]

const colors = paint({ isTTY: true })
const MARKUP = /<(info|comment|question|error)>(.*?)<\/\1>/gs
const TAGS = { info: 'green', comment: 'yellow', question: 'cyan', error: 'red' } as const
const LINKS = /<\/?href[^>]*>/g
const NAME_PARTS = /[-_]/
const PHP_PROFILE = /\b(?:php|frankenphp)\b/i
const PHPMYADMIN = /phpmyadmin/i

/** Symfony's console markup, in the colors the console itself gives it. */
export function marked(text: string): string {
  return text.replace(MARKUP, (_, tag: keyof typeof TAGS, inner: string) => colors[TAGS[tag]](inner)).replace(LINKS, '')
}

export function argumentsOf(command: Command): Argument[] {
  return Array.isArray(command.definition.arguments) ? [] : Object.values(command.definition.arguments)
}

function optionsOf(command: Command): Option[] {
  return Array.isArray(command.definition.options) ? [] : Object.values(command.definition.options)
}

function fromDir(dir: string, command: string[]): string[] {
  return dir === '.' ? command : ['env', '-C', dir, ...command]
}

function up(dir: string): string[] {
  const dirs: string[] = []

  for (let current = dir; ; current = join(current, '..')) {
    dirs.push(current)

    const absolute = resolve(current)

    if (existsSync(join(current, '.git')) || dirname(absolute) === absolute)
      return dirs
  }
}

function children(dir = '.'): string[] {
  const ignored = ignoredFolders()

  return readdirSync(dir, { withFileTypes: true })
    .filter(child => child.isDirectory() && !child.name.startsWith('.') && !ignored.has(child.name))
    .map(child => child.name)
    .toSorted()
}

/** Picks the PHP service: configured override first, then `php`, then `*-php`/`*_php`, then any service whose image/build profile mentions php/frankenphp (never phpmyadmin). */
export function phpService(candidates: (string | Pick<ComposeService, 'name' | 'profile'>)[], configured?: string): string | undefined {
  const list = candidates.map(item => typeof item === 'string' ? { name: item, profile: item.toLowerCase() } : item)

  if (configured !== undefined && configured !== '') {
    const exact = list.find(item => item.name === configured)

    if (exact !== undefined)
      return exact.name
  }

  return list.find(item => item.name === 'php')?.name
    ?? list.find(item => item.name.split(NAME_PARTS).includes('php'))?.name
    ?? list.find(item => !PHPMYADMIN.test(item.profile) && PHP_PROFILE.test(item.profile))?.name
}

function configuredService(): string | undefined {
  const value = readUserConfig('sf').service

  return typeof value === 'string' && value !== '' ? value : undefined
}

async function consoleAt(dir: string, serviceOverride?: string): Promise<Console> {
  const absDir = resolve(dir)
  const composeDir = findComposeDir(absDir)
  const composeServices = composeDir === undefined ? undefined : await readServices(composeDir)
  const php = composeServices === undefined ? undefined : phpService(composeServices, serviceOverride ?? configuredService())

  if (composeDir !== undefined && php !== undefined) {
    const relCompose = relative(process.cwd(), composeDir) || '.'

    return {
      dir,
      run: [...fromDir(relCompose, ['docker', 'compose']), 'exec', php, 'bin/console'],
      list: { argv: ['docker', 'compose', 'exec', '-T', php, 'bin/console'], cwd: composeDir, env: process.env },
    }
  }

  return { dir, run: fromDir(dir, ['php', 'bin/console']), list: { argv: ['php', 'bin/console'], cwd: absDir, env: process.env } }
}

/** The console of this folder or its nearest parent, then those of the child folders. */
async function consoles(serviceOverride?: string): Promise<Console[]> {
  const here = up('.').find(dir => existsSync(join(dir, 'bin/console')))
  const dirs = [...(here === undefined ? [] : [here]), ...children().filter(dir => existsSync(join(dir, 'bin/console')))]

  return Promise.all([...new Set(dirs)].map(async dir => consoleAt(dir, serviceOverride)))
}

function cached(dir: string): string {
  return join(cacheFolder(), 'sf', `${resolve(dir).replaceAll('/', '%')}.json`)
}

function fromCache(dir: string): Command[] | undefined {
  try {
    return existsSync(cached(dir)) ? JSON.parse(readFileSync(cached(dir), 'utf-8')) as Command[] : undefined
  }
  catch {
    return undefined
  }
}

export async function live(app: Console): Promise<Command[]> {
  let commands: Command[]

  try {
    const ran = await captureOutput([...app.list.argv, 'list', '--format=json'], { cwd: app.list.cwd, env: app.list.env })

    if (ran.code !== 0)
      return fromCache(app.dir) ?? []

    commands = (JSON.parse(ran.stdout) as { commands: Command[] }).commands.filter(command => !command.hidden)
  }
  catch {
    return fromCache(app.dir) ?? []
  }

  mkdirSync(dirname(cached(app.dir)), { recursive: true })
  writeFileSync(cached(app.dir), JSON.stringify(commands))

  return commands
}

async function entries(fresh: boolean, serviceOverride?: string): Promise<Entry[]> {
  const found = await consoles(serviceOverride)
  const lists = await Promise.all(found.map(async app => (fresh ? live(app) : fromCache(app.dir) ?? live(app))))

  return found.flatMap((app, index) => lists[index]!.map(command => ({ app, command })))
}

/** What names a command: `cache:clear` in this folder's console, `api/cache:clear` in a child's. */
export function key(entry: Entry): string {
  return entry.app.dir === '.' ? entry.command.name : `${entry.app.dir}/${entry.command.name}`
}

/** The namespace dimmed, the command standing out: `cache:` in `cache:clear`. */
function named(name: string): string {
  const colon = name.lastIndexOf(':')

  return colon === -1 ? name : `${colors.dim(name.slice(0, colon + 1))}${name.slice(colon + 1)}`
}

/** Required arguments read as `<name>`, the others as `[name]`, a list as `name...`. */
export function signature(command: Command): string {
  return argumentsOf(command)
    .map(argument => `${argument.is_required ? '<' : '['}${argument.name}${argument.is_array ? '...' : ''}${argument.is_required ? '>' : ']'}`)
    .join(' ')
}

/** A command as `sf --json` prints it, the arguments and options of the console's own definition. */
export function entryJson(entry: Entry) {
  const { command } = entry

  return {
    name: key(entry),
    command: command.name,
    dir: entry.app.dir,
    description: command.description,
    signature: signature(command),
    arguments: argumentsOf(command).map(argument => ({ name: argument.name, required: argument.is_required, array: argument.is_array, description: argument.description })),
    options: optionsOf(command).map(option => ({ name: option.name, shortcut: option.shortcut, acceptsValue: option.accept_value, description: option.description })),
  }
}

function rows(found: Entry[]): Row[] {
  return byRecency(found, runs('sf'), key).map(entry => ({
    hidden: [entry.app.dir, entry.command.name],
    cells: [entry.app.dir === '.' ? named(entry.command.name) : `${colors.dim(`${entry.app.dir}/`)}${named(entry.command.name)}`, colors.cyan(signature(entry.command)), colors.dim(entry.command.description)],
  }))
}

/** From the cache alone, the preview being called at every move. */
function preview(dir: string, name: string): void {
  const command = (fromCache(dir) ?? []).find(candidate => candidate.name === name)

  if (!command)
    return

  const lines = [
    colors.bold(command.description),
    '',
    colors.yellow('Usage:'),
    ...command.usage.map(line => `  ${line}`),
    ...(argumentsOf(command).length ? ['', colors.yellow('Arguments:'), ...argumentsOf(command).map(argument => `  ${colors.green(argument.name.padEnd(20))} ${argument.description}`)] : []),
    ...(optionsOf(command).length ? ['', colors.yellow('Options:'), ...optionsOf(command).map(option => `  ${colors.green(`--${option.name}${option.accept_value ? '=' : ''}`.padEnd(20))} ${option.description}`)] : []),
    ...(command.help ? ['', colors.yellow('Help:'), command.help] : []),
  ]

  console.log(marked(lines.join('\n')))
}

function takesNext(command: Command, word: string): boolean {
  const option = word.startsWith('--')
    ? optionsOf(command).find(each => each.name === word.slice(2))
    : optionsOf(command).find(each => each.shortcut.split('|').includes(word))

  return option?.accept_value === true
}

function argumentCount(command: Command, given: string[]): number {
  let count = 0
  let options = true
  let value = false

  for (const word of given) {
    const isValue = value && !word.startsWith('-')

    value = false

    if (isValue)
      continue

    if (!options || !word.startsWith('-') || word === '-')
      count++
    else if (word === '--')
      options = false
    else
      value = takesNext(command, word)
  }

  return count
}

/** The arguments given, then a prompt for each required one past them. */
export function commandFor(entry: Entry, given: string[]): Arg[] {
  const prompts = argumentsOf(entry.command).filter(argument => argument.is_required).slice(argumentCount(entry.command, given))

  return [...entry.app.run, entry.command.name, ...given.map(value => ({ given: value })), ...prompts.map(argument => ({ ask: argument.name }))]
}

/** The words of a command with every prompt answered, and the arguments a run is remembered with; undefined once a prompt is cancelled. */
export async function answered(command: Arg[], ask: (name: string) => Promise<string | undefined>): Promise<{ argv: string[], given: string[] } | undefined> {
  const argv: string[] = []
  const given: string[] = []

  for (const word of command) {
    if (typeof word === 'string') {
      argv.push(word)

      continue
    }

    const value = 'given' in word ? word.given : await ask(word.ask)

    if (value === undefined)
      return undefined

    argv.push(value)
    given.push(value)
  }

  return { argv, given }
}

async function execute(emitting: boolean, typed: string, recorded: string, command: Arg[]): Promise<number> {
  if (emitting) {
    emit('run', typed, recorded, command)

    return 0
  }

  if (!isInteractive() && command.some(word => typeof word === 'object' && 'ask' in word))
    fail('a required argument is missing and there is no terminal to ask for it', 1)

  const done = await answered(command, async name => input(`${name}:`, { history: `sf ${recorded || typed} ${name}`, hint: `pass ${name} as an argument after \`sf ${recorded || typed}\`` }))

  if (done === undefined)
    return 1

  if (recorded !== '')
    record('sf', { id: recorded, args: done.given })

  return Bun.spawn(done.argv, { stdio: ['inherit', 'inherit', 'inherit'] }).exited
}

function listing(found: Entry[]): string {
  const sorted = byRecency(found, runs('sf'), key)
  const labels = sorted.map(entry => [key(entry), signature(entry.command)].filter(Boolean).join(' '))
  const width = Math.max(...labels.map(label => label.length))

  return sorted.map((entry, index) => `${labels[index]!.padEnd(width)}  ${entry.command.description}`.trimEnd()).join('\n')
}

async function hidden(flag: string, rest: string[]): Promise<number | undefined> {
  if (flag === '--show') {
    preview(rest[0] ?? '.', rest[1] ?? '')

    return 0
  }

  if (flag === '--record') {
    record('sf', { id: rest[0] ?? '', args: rest.slice(1) })

    return 0
  }

  if (flag === '--rows') {
    console.log(table(rows(await entries(true))).join('\n'))

    return 0
  }

  if (flag !== '--list' && flag !== '--names')
    return undefined

  const refreshed = flag === '--list' && (await consoles()).some(found => fromCache(found.dir) !== undefined)
  const found = await entries(false)

  if (flag === '--names') {
    console.log(found.map(entry => `${key(entry)}\t${entry.command.description}`).join('\n'))

    return 0
  }

  if (refreshed)
    Bun.spawn([process.execPath, process.argv[1]!, '--rows'], { stdio: ['ignore', 'ignore', 'ignore'] }).unref()

  list(byRecency(found, runs('sf'), key).map(entry => ({
    label: [key(entry), signature(entry.command)].filter(Boolean).join(' '),
    hint: entry.command.description,
    typed: key(entry),
    preview: ['--show', entry.app.dir, entry.command.name],
  })))

  return 0
}

export async function sf(args: string[]): Promise<number> {
  const [flag = ''] = args

  if (args.length <= 2 && args.includes('--json') && (flag === '--json' || flag === '--list')) {
    const found = await entries(false)

    printJson(byRecency(found, runs('sf'), key).map(entryJson))

    return 0
  }

  const flagged = await hidden(flag, args.slice(1))

  if (flagged !== undefined)
    return flagged

  const emitting = flag === '--emit'
  const words = emitting ? args.slice(1) : args
  const last = words[0] === '-'
  const parsed = parse(last ? [] : words, usage, {
    service: { type: 'string', short: 's', description: 'compose service running PHP (overrides auto-detection and config.jsonc#sf.service)' },
  }, {
    positionals: ['[command]'],
    trailing: true,
    exits: EXITS,
    replaces: 'bin/console typed in the php container, with the command names and arguments looked up by hand',
    examples: ['sf', ['sf cache:clear', 'run it without the picker'], ['sf -s app cache:clear', 'target a custom PHP service'], ['sf -', 'the last command again, with its arguments']],
  })
  const [command] = parsed.positionals
  const given = last ? words.slice(1) : parsed.rest ?? []
  const serviceOverride = parsed.values.service
  const refreshed = command === undefined && !last && (await consoles(serviceOverride)).some(found => fromCache(found.dir) !== undefined)
  const found = await entries(false, serviceOverride)

  if (last) {
    const previous = runs('sf')[0]
    const entry = previous && found.find(candidate => key(candidate) === previous.id)

    if (entry === undefined)
      fail(previous ? `${previous.id} is gone` : 'nothing run here yet', 1)

    return execute(emitting, key(entry), key(entry), commandFor(entry, [...previous!.args, ...given]))
  }

  if (command !== undefined) {
    const entry = found.find(candidate => key(candidate) === command) ?? found.find(candidate => candidate.command.name === command)

    if (entry !== undefined)
      return execute(emitting, key(entry), key(entry), commandFor(entry, given))

    const [first] = await consoles(serviceOverride)

    if (first === undefined)
      fail('no bin/console here', 1)

    return execute(emitting, command, '', [...first.run, command, ...given.map(value => ({ given: value }))])
  }

  if (found.length === 0)
    fail('no bin/console here, or it listed no command', 1)

  if (!isInteractive()) {
    if (emitting)
      fail('the picker needs a terminal', 1)

    console.log(listing(found))

    return 0
  }

  const picked = await pick(rows(found), {
    prompt: 'sf> ',
    searched: 1,
    preview: `${process.execPath} ${process.argv[1]} --show {1} {2}`,
    reload: refreshed ? { onOpen: true, run: async () => ({ rows: rows(await entries(true, serviceOverride)) }) } : undefined,
  })
  const entry = picked && (await entries(false, serviceOverride)).find(candidate => candidate.app.dir === picked.hidden[0] && candidate.command.name === picked.hidden[1])

  return entry === undefined ? 1 : execute(emitting, key(entry), key(entry), commandFor(entry, []))
}
