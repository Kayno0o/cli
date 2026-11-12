import type { ExitRow } from '@kaynooo/cli-kit'
import type { Arg, Row } from '@kaynooo/cli-kit/picker'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { cacheFolder, fail, isInteractive, paint, parse, printJson } from '@kaynooo/cli-kit'
import { byRecency, emit, list, pick, record, runs, table } from '@kaynooo/cli-kit/picker'
import { input } from '@kaynooo/cli-kit/prompt'
import { spawnText } from '@kaynooo/utils/cli'
import { children, from, nearestStack, services, up } from './stack'

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

const usage = `sf [command] [args...]
sf -

Picks a Symfony console command on a terminal and runs it, asking for each required argument; without a terminal (a script, a pipe, an agent) it lists the commands, the form to use there.
The console is the nearest \`bin/console\` up to the repository root, then those of the child folders (keyed \`api/cache:clear\`), run in the php service of the nearest compose stack when there is one, else with the local php.
\`sf -\` runs the last command again with its arguments, \`sf <command> [args...]\` runs without the picker, a name the list does not hold going to the console as is.`

const EXITS: ExitRow[] = [['the code of the console', 'a command it ran'], [0, 'it listed the commands'], [1, 'no bin/console here, or it listed no command'], [2, 'a usage error']]

/** Fzf paints its rows and previews itself, so these keep their colors whatever stream they are written to; `paint` still honours `NO_COLOR`. */
const colors = paint({ isTTY: true })
const MARKUP = /<(info|comment|question|error)>(.*?)<\/\1>/gs
const TAGS = { info: 'green', comment: 'yellow', question: 'cyan', error: 'red' } as const
const LINKS = /<\/?href[^>]*>/g

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

/** The php service by name, `php` itself before `booki-php` or `dorad_php`. */
export function phpService(names: string[]): string | undefined {
  return names.find(name => name === 'php') ?? names.find(name => name.includes('php'))
}

async function consoleAt(dir: string): Promise<Console> {
  const stack = nearestStack(dir)
  const php = stack === undefined ? undefined : phpService((await services(stack)).map(service => service.name))

  if (stack !== undefined && php !== undefined)
    return { dir, run: [...stack.run, 'exec', php, 'bin/console'], list: { ...stack.list, argv: [...stack.list.argv, 'exec', '-T', php, 'bin/console'] } }

  return { dir, run: from(dir, ['php', 'bin/console']), list: { argv: ['php', 'bin/console'], cwd: resolve(dir), env: process.env } }
}

/** The console of this folder or its nearest parent, then those of the child folders. */
async function consoles(): Promise<Console[]> {
  const here = up('.').find(dir => existsSync(join(dir, 'bin/console')))
  const dirs = [...(here === undefined ? [] : [here]), ...children().filter(dir => existsSync(join(dir, 'bin/console')))]

  return Promise.all([...new Set(dirs)].map(consoleAt))
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
    const text = await spawnText([...app.list.argv, 'list', '--format=json'], { cwd: app.list.cwd, env: app.list.env })

    commands = (JSON.parse(text) as { commands: Command[] }).commands.filter(command => !command.hidden)
  }
  catch {
    return fromCache(app.dir) ?? []
  }

  mkdirSync(dirname(cached(app.dir)), { recursive: true })
  writeFileSync(cached(app.dir), JSON.stringify(commands))

  return commands
}

async function entries(fresh: boolean): Promise<Entry[]> {
  const found = await consoles()
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

  // Laid out as `bin/console help` has it.
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

/** The arguments given, then a prompt for each required one past them. */
export function commandFor(entry: Entry, given: string[]): Arg[] {
  const prompts = argumentsOf(entry.command).filter(argument => argument.is_required).slice(given.length)

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

function interactive(): boolean {
  return isInteractive()
}

/** What `--emit` prints for tmux, or, standalone, the command run once its prompts are answered. */
async function execute(emitting: boolean, typed: string, recorded: string, command: Arg[]): Promise<number> {
  if (emitting) {
    emit('run', typed, recorded, command)

    return 0
  }

  if (!interactive() && command.some(word => typeof word === 'object' && 'ask' in word))
    fail('a required argument is missing and there is no terminal to ask for it', 1)

  const done = await answered(command, async name => input(`${name}:`, { history: `sf ${recorded || typed} ${name}` }))

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

/** The hidden flags term, tmux and the shell completions call, each printing and nothing more. */
async function hidden(flag: string, rest: string[]): Promise<number | undefined> {
  if (flag === '--show') {
    preview(rest[0] ?? '.', rest[1] ?? '')

    return 0
  }

  if (flag === '--record') {
    record('sf', { id: rest[0] ?? '', args: rest.slice(1) })

    return 0
  }

  // Brings the cache of the consoles up to date, which `--list` starts in the background for the next time.
  if (flag === '--rows') {
    console.log(table(rows(await entries(true))).join('\n'))

    return 0
  }

  if (flag !== '--list' && flag !== '--names')
    return undefined

  const refreshed = flag === '--list' && (await consoles()).some(found => fromCache(found.dir) !== undefined)
  const found = await entries(false)

  if (flag === '--names') {
    // With the description as the one fish shows beside each name.
    console.log(found.map(entry => `${key(entry)}\t${entry.command.description}`).join('\n'))

    return 0
  }

  // From the cache, which a list run in the background brings up to date for the next time, as the picker's reload does.
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

  // The protocol the tmux picker reads instead of running the command: its mode, the words typed back, and the command's words.
  const emitting = flag === '--emit'
  const words = emitting ? args.slice(1) : args
  const last = words[0] === '-'
  const parsed = parse(last ? [] : words, usage, {}, {
    positionals: ['[command]'],
    trailing: true,
    exits: EXITS,
    replaces: 'bin/console typed in the php container, with the command names and arguments looked up by hand',
    examples: ['sf', ['sf cache:clear', 'run it without the picker'], ['sf c:c --env=prod', 'the console resolves abbreviations itself'], ['sf -', 'the last command again, with its arguments']],
  })
  const [command] = parsed.positionals
  const given = last ? words.slice(1) : parsed.rest ?? []
  const refreshed = command === undefined && !last && (await consoles()).some(found => fromCache(found.dir) !== undefined)
  const found = await entries(false)

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

    // Left to the console, which knows its abbreviations and suggests the nearest command itself.
    const [first] = await consoles()

    if (first === undefined)
      fail('no bin/console here', 1)

    return execute(emitting, command, '', [...first.run, command, ...given.map(value => ({ given: value }))])
  }

  if (found.length === 0)
    fail('no bin/console here, or it listed no command', 1)

  if (!interactive()) {
    if (emitting)
      fail('the picker needs a terminal', 1)

    console.log(listing(found))

    return 0
  }

  const picked = await pick(rows(found), {
    prompt: 'sf> ',
    searched: 1,
    preview: `${process.execPath} ${process.argv[1]} --show {1} {2}`,
    // Opens on the cached list, which the consoles' own answer replaces once it is in.
    reload: refreshed ? { onOpen: true, run: async () => ({ rows: rows(await entries(true)) }) } : undefined,
  })
  // Read again, the reload having maybe brought a command the first list did not hold.
  const entry = picked && (await entries(false)).find(candidate => candidate.app.dir === picked.hidden[0] && candidate.command.name === picked.hidden[1])

  return entry === undefined ? 1 : execute(emitting, key(entry), key(entry), commandFor(entry, []))
}
