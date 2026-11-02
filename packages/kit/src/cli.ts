import type { Example, Options } from './args'
import type { Colors } from './style'
import process from 'node:process'
import { applyOutput, Completing, completion, description, exampleRows, Exit, HelpShown, optionRows, OUTPUT_OPTIONS, replacesRows, UsageError, usageLine, wantsHelpJson } from './args'
import { paint, takesControlCodes } from './style'
import { closest } from './text'

// A command's one-line summary, or a function reading it (a lazily loaded module) that only a listing of the command awaits, never a run.
export type Summary = string | (() => Promise<string>)

export type Commands = Record<string, Command>

// Commands known only once something is read, called with the words typed so far from the CLI's name on, and only when a word is not a command the level already has, or for a help or `__complete`.
export type LazyCommands = (words: string[]) => Promise<Commands>

export type Command = {
  summary: Summary
  // The heading the command is listed under in the help, after those with none.
  group?: string
  // Runs as usual but is left out of the help, the typo hints and `__complete`, for a command only a script or a shell binding calls.
  hidden?: boolean
} & (
  | { run: (args: string[]) => Promise<number> }
  // A group of subcommands dispatched the same way, with its own help; `commands` may be a function for a group made of lazy commands alone.
  | { commands: Commands | LazyCommands, extraCommands?: LazyCommands, aliases?: Record<string, string>, examples?: Example[] }
)

export interface Cli {
  name: string
  version: string
  // One line after `<name> <version>: ` in the help.
  about: string
  // The commands, or a function giving them all lazily.
  commands: Commands | LazyCommands
  // Lazy commands added to `commands`, which win a name they share.
  extraCommands?: LazyCommands
  // Names sessions reach for that mean an existing command.
  aliases?: Record<string, string>
  // The command that takes the arguments when the first one names no command, so `db "select 1"` runs `db query "select 1"`; `--help` lists its options under the commands.
  defaultCommand?: string
  // Rewrites an error's message and cause before they print, for a CLI whose errors may quote what a log must not keep.
  redact?: (text: string) => string
  // Command lines shown under `Examples:` in `<cli> --help`; a command's own go to `parse`.
  examples?: Example[]
  // What the CLI is reached for instead of, shown as `Instead of:` in `<cli> --help`.
  replaces?: string
}

const LEVEL_OPTIONS = {
  ...OUTPUT_OPTIONS,
  help: { type: 'boolean', short: 'h', description: 'show this help' },
} as const satisfies Options
const TOP_OPTIONS = { ...LEVEL_OPTIONS, version: { type: 'boolean', short: 'v', description: 'print the version' } } as const satisfies Options

// The rows under `Commands:`, then a heading per group in the order first met, names aligned across them all.
async function commandRows(all: Commands, colors: Colors): Promise<string[]> {
  const commands = shown(all)
  const width = Math.max(0, ...Object.keys(commands).map(name => name.length))
  const groups = new Map<string, string[]>([['Commands:', []]])
  const summaries = await Promise.all(Object.values(commands).map(async ({ summary }) => resolveSummary(summary)))

  for (const [index, [name, { group }]] of Object.entries(commands).entries()) {
    const heading = group === undefined ? 'Commands:' : `${group}:`
    const rows = groups.get(heading) ?? []

    rows.push(`  ${colors.cyan(name.padEnd(width))}  ${colors.dim(summaries[index]!)}`)
    groups.set(heading, rows)
  }

  return [...groups].filter(([, rows]) => rows.length > 0).flatMap(([heading, rows], index) => [...index === 0 ? [] : [''], colors.bold(heading), ...rows])
}

// The commands that are not hidden.
function shown(commands: Commands): Commands {
  return Object.fromEntries(Object.entries(commands).filter(([, { hidden }]) => hidden !== true))
}

// The output flags typed before the command name, applied and dropped: `ft --plain runs`.
function takeOutputFlags(argv: string[]): string[] {
  let index = 0

  for (; index < argv.length; index++) {
    const word = argv[index]!

    if (word === '--plain')
      applyOutput(undefined, true)
    else if (word.startsWith('--color='))
      applyOutput(word.slice('--color='.length), undefined)
    else if (word === '--color' && argv[index + 1] !== undefined)
      applyOutput(argv[++index], undefined)
    else
      break
  }

  return argv.slice(index)
}

// What a level lists and dispatches: the commands it has, and the functions giving more once called.
interface Scope {
  commands: Commands
  lazy: LazyCommands[]
  aliases: Record<string, string> | undefined
}

interface Level extends Scope {
  // The words typed to reach this level, `ft plan`.
  path: string[]
  header: (colors: Colors, summary: string) => string
  summary: Summary
  defaultCommand: string | undefined
  examples: Example[] | undefined
  replaces: string | undefined
}

async function resolveSummary(summary: Summary): Promise<string> {
  return typeof summary === 'string' ? summary : summary()
}

function scopeOf(commands: Commands | LazyCommands, extra: LazyCommands | undefined, aliases: Record<string, string> | undefined): Scope {
  return { commands: typeof commands === 'function' ? {} : commands, lazy: [...typeof commands === 'function' ? [commands] : [], ...extra === undefined ? [] : [extra]], aliases }
}

// The scope with its lazy commands called with the words typed so far and merged in, the ones it already has winning a shared name.
async function expand<T extends Scope>(scope: T, words: string[]): Promise<T> {
  if (scope.lazy.length === 0)
    return scope

  const commands = { ...scope.commands }

  for (const added of await Promise.all(scope.lazy.map(async lazy => lazy(words)))) {
    for (const [name, command] of Object.entries(added))
      commands[name] ??= command
  }

  return { ...scope, commands, lazy: [] }
}

// The level's help; a default command's options follow the commands, as they apply with no command named.
async function help({ path, header, summary: lazySummary, commands, defaultCommand, examples, replaces }: Level, stream: { isTTY?: boolean }): Promise<string> {
  const colors = paint(stream)
  const prefix = path.join(' ')
  const summary = await resolveSummary(lazySummary)

  if (wantsHelpJson())
    return JSON.stringify(description(`${prefix} <command> [options]: ${summary}`, { examples, replaces }))

  const fallback = defaultCommand === undefined ? undefined : commands[defaultCommand]
  const options = fallback !== undefined && 'run' in fallback ? await optionsOf(fallback.run) : undefined
  // The default command's own run lists the output flags again, so they show once, under the level's.
  const own = Object.entries(options ?? {}).filter(([name]) => !(name in TOP_OPTIONS))

  return [
    header(colors, summary),
    '',
    usageLine(`${prefix} ${defaultCommand === undefined ? colors.cyan('<command>') : `[${colors.cyan('<command>')}]`} [options]`, colors),
    ...replacesRows(replaces, colors),
    '',
    ...await commandRows(commands, colors),
    ...own.length === 0 ? [] : ['', `${colors.bold(`Options of ${defaultCommand}:`)} ${colors.dim('the command run when none is named')}`, ...optionRows(Object.fromEntries(own), colors)],
    '',
    colors.bold('Options:'),
    ...optionRows(path.length === 1 ? TOP_OPTIONS : LEVEL_OPTIONS, colors),
    ...exampleRows(examples ?? [], colors),
    '',
    `${colors.dim('Run')} ${prefix} ${colors.cyan('<command>')} --help ${colors.dim('for its options.')}`,
  ].join('\n')
}

// `error <prefix>: <message>` on stderr, the cause and the hint each on a line of their own under it; plain words off a terminal.
export function printError(prefix: string, message: string, hint?: string, cause?: string): void {
  const colors = paint(process.stderr)
  const styled = takesControlCodes(process.stderr)
  const head = styled ? `${colors.red.bold('error')} ${colors.dim(`${prefix}:`)}` : `error: ${prefix}:`
  const under = (label: string, text: string | undefined, tint: (text: string) => string) => text === undefined ? '' : `\n  ${styled ? tint(label) : `${label}:`} ${text}`

  console.error(`${head} ${message}${under('cause', cause, colors.dim)}${under('hint', hint, colors.yellow)}`)
}

// The hint of a refusal a command resolves with another command, worded alike everywhere: ``run `ft take 12 --take-stale` ``, then what it does when that is not obvious.
export function runHint(command: string, effect?: string): string {
  return `run \`${command}\`${effect === undefined ? '' : ` to ${effect}`}`
}

// A hint under a refusal a command prints itself, laid out as printError lays it.
export function printHint(hint: string): void {
  const colors = paint(process.stderr)

  console.error(`  ${takesControlCodes(process.stderr) ? colors.yellow('hint') : 'hint:'} ${hint}`)
}

// An error as `{"error", "hint"?, "cause"?}` on stderr, for a command run with `--json`, so a caller parses its failures as it parses its output.
export function printJsonError(message: string, hint?: string, cause?: string): void {
  console.error(JSON.stringify({ error: message, ...(hint === undefined ? {} : { hint }), ...(cause === undefined ? {} : { cause }) }))
}

// Whether the arguments ask for JSON, read before parsing so even a parse error prints as JSON.
function wantsJson(argv: readonly string[]): boolean {
  const end = argv.indexOf('--')

  return (end === -1 ? argv : argv.slice(0, end)).includes('--json')
}

// What a thrown error prints as and exits with: an Exit its own code and hint, a UsageError pointed at the help, HelpShown nothing at all and 0, anything else 1.
// An error other than an Exit is named unless a plain `Error` (`MigrationError: ...`), and its cause's message printed under it, never the cause itself.
function reportThrown(prefix: string, error: unknown, redact: (text: string) => string = text => text, json = false): number {
  if (error instanceof HelpShown)
    return 0

  const help = error instanceof UsageError ? `run ${prefix} --help for its options` : undefined
  const named = error instanceof Error && !(error instanceof Exit) && error.name !== 'Error' ? `${error.name}: ${error.message}` : undefined
  const cause = error instanceof Error && error.cause instanceof Error ? redact(error.cause.message) : undefined

  const report = json ? printJsonError : (message: string, hint?: string, causeText?: string) => printError(prefix, message, hint, causeText)

  report(redact(named ?? (error instanceof Error ? error.message : String(error))), error instanceof Exit ? error.hint ?? help : undefined, cause)

  return error instanceof Exit ? error.code : 1
}

async function dispatch(level: Level, typed: string[], { version, redact }: { version: string, redact: Cli['redact'] | undefined }): Promise<number> {
  const prefix = level.path.join(' ')
  let argv: string[]

  try {
    argv = takeOutputFlags(typed)
  }
  catch (error) {
    return reportThrown(prefix, error)
  }

  const [name, ...args] = argv

  if (name === undefined && level.path.length > 1) {
    console.error(await help(await expand(level, [...level.path.slice(1), ...argv]), process.stderr))

    return 2
  }

  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    console.log(await help(await expand(level, [...level.path.slice(1), ...argv]), process.stdout))

    return 0
  }

  if (level.path.length === 1 && (name === '--version' || name === '-v')) {
    console.log(version)

    return 0
  }

  let command = level.commands[level.aliases?.[name] ?? name]
  let rest = args

  if (command === undefined && level.lazy.length > 0) {
    level = await expand(level, [...level.path.slice(1), ...argv])
    command = level.commands[level.aliases?.[name] ?? name]
  }

  if (command === undefined && level.defaultCommand !== undefined) {
    command = level.commands[level.defaultCommand]
    rest = argv
  }

  if (command === undefined) {
    const meant = closest(name, Object.keys(shown(level.commands)))

    printError(prefix, `no command ${name}`, meant === undefined ? `run ${prefix} --help for its commands` : `did you mean ${meant}?`)

    return 2
  }

  if ('commands' in command) {
    const { summary } = command

    return dispatch({ path: [...level.path, name], header: (colors, text) => `${colors.bold(`${prefix} ${name}`)}  ${text}`, summary, ...scopeOf(command.commands, command.extraCommands, command.aliases), defaultCommand: undefined, examples: command.examples, replaces: undefined }, rest, { version, redact })
  }

  try {
    return await command.run(rest)
  }
  catch (error) {
    return reportThrown(`${prefix} ${name}`, error, redact, wantsJson(rest))
  }
}

// The hidden first argument a shell completion calls a bin with: `<bin> __complete <words typed after it>... <word being typed>`.
export const COMPLETE = '__complete'
// Printed instead of candidates where a path fits, for the shell to complete files itself.
export const FILES = '__files__'

// A command's options, read by running it until its parse call throws them: every command parses its arguments before anything else.
async function optionsOf(run: (args: string[]) => Promise<number>): Promise<Options> {
  completion.active = true

  try {
    await run([])
  }
  catch (error) {
    if (error instanceof Completing)
      return error.options
  }
  finally {
    completion.active = false
  }

  return {}
}

// A leaf command's candidates: the choices of the string option just typed, its long options for a word starting with a dash, else paths.
async function leafCandidates(run: (args: string[]) => Promise<number>, words: string[]): Promise<string[]> {
  if (!(words.at(-1) ?? '').startsWith('-')) {
    const flag = words.at(-2)
    const option = flag?.startsWith('-') === true ? Object.entries(await optionsOf(run)).find(([name, { short }]) => flag === `--${name}` || flag === `-${short}`)?.[1] : undefined

    return option?.type === 'string' && option.choices !== undefined ? [...option.choices] : [FILES]
  }

  return Object.entries(await optionsOf(run)).map(([name, option]) => option.description === undefined ? `--${name}` : `--${name}\t${option.description}`)
}

// The candidates for the last word, `value\tdescription` per line, after walking the subcommands the earlier words name.
async function candidates(scope: Scope, defaultCommand: string | undefined, words: string[], before: string[] = []): Promise<string[]> {
  const [word = '', ...rest] = words
  const listing = rest.length === 0 && !word.startsWith('-')
  let { commands, aliases } = scope
  let command = commands[aliases?.[word] ?? word]

  if (listing || command === undefined) {
    ({ commands, aliases } = await expand(scope, [...before, ...words]))
    command = commands[aliases?.[word] ?? word]
  }

  if (listing)
    return Promise.all(Object.entries(shown(commands)).map(async ([name, { summary }]) => `${name}\t${await resolveSummary(summary)}`))

  if (command === undefined) {
    const fallback = defaultCommand === undefined ? undefined : commands[defaultCommand]

    return fallback !== undefined && 'run' in fallback ? leafCandidates(fallback.run, words) : []
  }

  return 'commands' in command ? candidates(scopeOf(command.commands, command.extraCommands, command.aliases), undefined, rest, [...before, word]) : leafCandidates(command.run, rest)
}

async function printCandidates(found: Promise<string[]>): Promise<number> {
  for (const line of await found)
    console.log(line)

  return 0
}

// Runs the command argv names and returns the exit code: 0 for help and version, 2 for an unknown command.
export async function runCli(cli: Cli, argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === COMPLETE)
    return printCandidates(candidates(scopeOf(cli.commands, cli.extraCommands, cli.aliases), cli.defaultCommand, argv.slice(1)))

  return dispatch({ path: [cli.name], header: (colors, about) => `${colors.bold(cli.name)} ${colors.dim(cli.version)}  ${about}`, summary: cli.about, ...scopeOf(cli.commands, cli.extraCommands, cli.aliases), defaultCommand: cli.defaultCommand, examples: cli.examples, replaces: cli.replaces }, argv, { version: cli.version, redact: cli.redact })
}

export interface Main {
  name: string
  version: string
  run: (args: string[]) => Promise<number>
  redact?: (text: string) => string
}

// Runs a CLI that is a single command: `--version` or `-v` alone prints the version, an `Exit` or any error prints as `error: <name>: <message>`. Returns the exit code.
export async function runMain({ name, version, run, redact }: Main, argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === COMPLETE)
    return printCandidates(leafCandidates(run, argv.slice(1)))

  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    console.log(version)

    return 0
  }

  try {
    return await run(argv)
  }
  catch (error) {
    return reportThrown(name, error, redact, wantsJson(argv))
  }
}
