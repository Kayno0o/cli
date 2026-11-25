import type { Example, Options } from './args'
import type { Command, Commands, LazyCommands, Scope, Summary } from './complete'
import type { Colors } from './style'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { applyOutput, description, exampleRows, Exit, heading, HelpShown, optionRows, OUTPUT_OPTIONS, UsageError, usageLine, wantsHelpJson } from './args'
import { scriptArgs } from './argv'
import { askpassClient } from './askpass'
import { candidates, COMPLETE, COMPLETIONS, expand, FILES, flagValue, leafCandidates, lookup, optionsOf, printCandidates, printCompletionScript, resolveSummary, scopeOf, shown } from './complete'
import { COMPLETION_SHELLS } from './completions'
import { outputMode } from './mode'
import { notifyEnd } from './notify'
import { paint, takesControlCodes, writeErr } from './style'
import { closest } from './text'
import { noteUsageError, recordUsage, usageEntry } from './usage'

export { COMPLETE, COMPLETIONS, FILES }
export type { Command, Commands, LazyCommands, Summary }

export interface Cli {
  name: string
  // The package's own by default, read from the nearest package.json above the entry file.
  version?: string
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
  // With `defaultCommand`, a bare `<cli>` runs it instead of printing the help (`account` lists, `mux` attaches).
  runBare?: boolean
  // Rewrites an error's message and cause before they print, for a CLI whose errors may quote what a log must not keep.
  redact?: (text: string) => string
  // Set to false for a bin run on every tool call, which would fill the usage log (`guard hook`).
  usage?: false
  // Command lines shown under `Examples:` in `<cli> --help`; a command's own go to `parse`.
  examples?: Example[]
  // What the CLI is reached for instead of, listed by `cli list`.
  replaces?: string
}

const LEVEL_OPTIONS = {
  ...OUTPUT_OPTIONS,
  help: { type: 'boolean', short: 'h', description: 'show this help' },
} as const satisfies Options
const TOP_OPTIONS = {
  ...LEVEL_OPTIONS,
  version: { type: 'boolean', short: 'v', description: 'print the version' },
  completions: { type: 'string', choices: COMPLETION_SHELLS, description: 'print the shell completion script' },
} as const satisfies Options

// The rows under `Commands:`, then a heading per group in the order first met, names aligned across them all.
async function commandRows(all: Commands, colors: Colors): Promise<string[]> {
  const commands = shown(all)
  const width = Math.max(0, ...Object.keys(commands).map(name => name.length))
  const groups = new Map<string, string[]>([['Commands:', []]])
  const summaries = await Promise.all(Object.values(commands).map(async ({ summary }) => resolveSummary(summary)))

  for (const [index, [name, { group }]] of Object.entries(commands).entries()) {
    const label = group === undefined ? 'Commands:' : `${group}:`
    const rows = groups.get(label) ?? []

    rows.push(`  ${colors.cyan(name.padEnd(width))}  ${colors.dim(summaries[index]!)}`)
    groups.set(label, rows)
  }

  return [...groups].filter(([, rows]) => rows.length > 0).flatMap(([label, rows], index) => [...index === 0 ? [] : [''], colors.bold(label), ...rows])
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

interface Level extends Scope {
  // The words typed to reach this level, `ft plan`.
  path: string[]
  header: (colors: Colors, summary: string) => string
  summary: Summary
  defaultCommand: string | undefined
  // Whether a bare run of the level runs its default command instead of printing the help.
  runBare: boolean
  examples: Example[] | undefined
  replaces: string | undefined
}

// The level's help; a default command's options follow the commands, as they apply with no command named.
async function help({ path, header, summary: lazySummary, commands, defaultCommand, examples, replaces }: Level, stream: { isTTY?: boolean, columns?: number }, json = false): Promise<string> {
  const colors = paint(stream)
  const prefix = path.join(' ')
  const summary = await resolveSummary(lazySummary)

  if (json || wantsHelpJson())
    return JSON.stringify(description(`${prefix} <command> [options]: ${summary}`, { examples, replaces }))

  const columns = takesControlCodes(stream) ? stream.columns : undefined
  const fallback = defaultCommand === undefined ? undefined : commands[defaultCommand]
  const options = fallback !== undefined && 'run' in fallback ? await optionsOf(fallback.run) : undefined
  // The default command's own run lists the output flags again, so they show once, under the level's.
  const own = Object.entries(options ?? {}).filter(([name]) => !(name in TOP_OPTIONS))

  return [
    header(colors, summary),
    '',
    usageLine(`${prefix} ${defaultCommand === undefined ? colors.cyan('<command>') : `[${colors.cyan('<command>')}]`} [options]`, colors),
    '',
    ...await commandRows(commands, colors),
    ...own.length === 0 ? [] : ['', `${colors.bold(`Options of ${defaultCommand}:`)} ${colors.dim('the command run when none is named')}`, ...optionRows(Object.fromEntries(own), colors, columns)],
    '',
    colors.bold('Options:'),
    ...optionRows(path.length === 1 ? TOP_OPTIONS : LEVEL_OPTIONS, colors, columns),
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

  writeErr(`${head} ${message}${under('cause', cause, colors.dim)}${under('hint', hint, colors.yellow)}`)
}

// The hint of a refusal a command resolves with another command, worded alike everywhere: ``run `ft take 12 --take-stale` ``, then what it does when that is not obvious.
export function runHint(command: string, effect?: string): string {
  return `run \`${command}\`${effect === undefined ? '' : ` to ${effect}`}`
}

// A hint under a refusal a command prints itself, laid out as printError lays it.
export function printHint(hint: string): void {
  const colors = paint(process.stderr)

  writeErr(`  ${takesControlCodes(process.stderr) ? colors.yellow('hint') : 'hint:'} ${hint}`)
}

// An error as `{"error", "code"?, "command"?, "hint"?, "cause"?}` on stderr, for a command run with `--json`, so a caller parses its failures as it parses its output.
export function printJsonError(message: string, hint?: string, cause?: string, extra?: { code?: number, command?: string }): void {
  writeErr(JSON.stringify({
    error: message,
    ...(extra?.code === undefined ? {} : { code: extra.code }),
    ...(extra?.command === undefined ? {} : { command: extra.command }),
    ...(hint === undefined ? {} : { hint }),
    ...(cause === undefined ? {} : { cause }),
  }))
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

  const code = error instanceof Exit ? error.code : 1
  const helpHint = error instanceof UsageError ? `run ${prefix} --help for its options` : undefined
  const named = error instanceof Error && !(error instanceof Exit) && error.name !== 'Error' ? `${error.name}: ${error.message}` : undefined
  const cause = error instanceof Error && error.cause instanceof Error ? redact(error.cause.message) : undefined

  if (error instanceof Exit && error.code === 2)
    noteUsageError(error.message)

  const report = json
    ? (message: string, hint?: string, causeText?: string) => printJsonError(message, hint, causeText, { code, command: prefix })
    : (message: string, hint?: string, causeText?: string) => printError(prefix, message, hint, causeText)

  report(redact(named ?? (error instanceof Error ? error.message : String(error))), error instanceof Exit ? error.hint ?? helpHint : undefined, cause)

  return code
}

async function dispatch(level: Level, typed: string[], { version, redact }: { version: () => string, redact: Cli['redact'] | undefined }): Promise<{ code: number, meta: boolean }> {
  const prefix = level.path.join(' ')
  let argv: string[]

  try {
    argv = takeOutputFlags(typed)
  }
  catch (error) {
    return { code: reportThrown(prefix, error, redact, wantsJson(typed)), meta: false }
  }

  const [name, ...args] = argv
  const fallback = level.defaultCommand === undefined ? undefined : level.commands[level.defaultCommand]

  if (name === undefined && level.runBare && fallback !== undefined && 'run' in fallback) {
    try {
      return { code: await fallback.run([]), meta: false }
    }
    catch (error) {
      return { code: reportThrown(`${prefix} ${level.defaultCommand}`, error, redact, false), meta: error instanceof HelpShown }
    }
  }

  if (name === undefined && level.path.length > 1) {
    writeErr(await help(await expand(level, [...level.path.slice(1), ...argv]), process.stderr))

    return { code: 2, meta: true }
  }

  if (name === 'help' && args.length > 0 && args[0] !== '--json')
    return dispatch(level, [...args, '--help'], { version, redact })

  if (name === undefined || name === 'help' || name === '--help' || name === '-h' || name === '--help=json') {
    console.log(await help(await expand(level, [...level.path.slice(1), ...argv]), process.stdout, wantsHelpJson(process.env, argv)))

    return { code: 0, meta: true }
  }

  if (level.path.length === 1 && (name === '--version' || name === '-v')) {
    console.log(version())

    return { code: 0, meta: true }
  }

  let command = lookup(level, name)
  let rest = args
  let ran = name

  if (command === undefined && level.lazy.length > 0) {
    level = await expand(level, [...level.path.slice(1), ...argv])
    command = lookup(level, name)
  }

  if (command === undefined && level.defaultCommand !== undefined) {
    command = level.commands[level.defaultCommand]
    rest = argv
    ran = level.defaultCommand
  }

  if (command === undefined) {
    const meant = closest(name, Object.keys(shown(level.commands)))
    const hint = meant === undefined ? `run ${prefix} --help for its commands` : `did you mean ${meant}?`

    if (wantsJson(argv))
      printJsonError(`no command ${name}`, hint, undefined, { code: 2, command: prefix })
    else
      printError(prefix, `no command ${name}`, hint)

    return { code: 2, meta: false }
  }

  if ('commands' in command) {
    const { summary } = command

    return dispatch({ path: [...level.path, name], header: (colors, text) => `${colors.bold(`${prefix} ${name}`)}  ${text}`, summary, ...scopeOf(command.commands, command.extraCommands, command.aliases), defaultCommand: command.defaultCommand, runBare: command.runBare === true, examples: command.examples, replaces: undefined }, rest, { version, redact })
  }

  try {
    return { code: await command.run(rest), meta: false }
  }
  catch (error) {
    return { code: reportThrown(`${prefix} ${ran}`, error, redact, wantsJson(rest)), meta: error instanceof HelpShown }
  }
}

// The version of the nearest package.json above the entry file (symlinks resolved) that holds one, `0.0.0` when none does, an entry that is no file included, such as a `bun build --compile` binary's `/$bunfs/root/<name>`.
export function packageVersion(entry = Bun.main): string {
  let resolved = entry

  try {
    resolved = realpathSync(entry)
  }
  catch {}

  for (let dir = dirname(resolved); ; dir = dirname(dir)) {
    try {
      const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }

      if (typeof version === 'string')
        return version
    }
    catch {}

    if (dirname(dir) === dir)
      return '0.0.0'
  }
}

// Runs the command argv names and returns the exit code: 0 for help and version, 2 for an unknown command.
export async function runCli(cli: Cli, argv = scriptArgs()): Promise<number> {
  const answered = await askpassClient(argv)

  if (answered !== undefined)
    return answered

  if (argv[0] === COMPLETE)
    return printCandidates(candidates(scopeOf(cli.commands, cli.extraCommands, cli.aliases), cli.defaultCommand, argv.slice(1)))

  if (argv[0] === COMPLETIONS || argv[0]?.startsWith(`${COMPLETIONS}=`) === true)
    return printCompletionScript(cli.name, flagValue(argv), printError)

  // Version is read lazily so a normal command never walks the filesystem for package.json.
  const version = () => cli.version ?? packageVersion()
  const started = performance.now()
  const { code, meta } = await dispatch({ path: [cli.name], header: (colors, about) => `${colors.bold(cli.name)} ${colors.dim(version())}  ${about}`, summary: cli.about, ...scopeOf(cli.commands, cli.extraCommands, cli.aliases), defaultCommand: cli.defaultCommand, runBare: cli.runBare === true, examples: cli.examples, replaces: cli.replaces }, argv, { version, redact: cli.redact })
  const command = commandPath(scopeOf(cli.commands, cli.extraCommands, cli.aliases), argv)

  notifyEnd(command === undefined ? cli.name : `${cli.name} ${command}`, code, performance.now() - started)

  if (cli.usage !== false && !meta) {
    try {
      recordUsage(usageEntry(cli.name, command, argv, code, { ms: performance.now() - started, mode: outputMode() }))
    }
    catch {}
  }

  return code
}

// The command words the arguments start with, a group's subcommand included; lazy commands are not loaded for it.
function commandPath(scope: Pick<Level, 'commands' | 'aliases'>, argv: readonly string[]): string | undefined {
  const path: string[] = []
  let level = scope

  for (const word of argv.filter(each => !each.startsWith('-'))) {
    const command = lookup(level, word)

    if (command === undefined)
      break

    path.push(word)

    if (!('commands' in command))
      break

    level = scopeOf(command.commands, command.extraCommands, command.aliases)
  }

  return path.length === 0 ? undefined : path.join(' ')
}

export interface Main {
  name: string
  // The package's own by default, read from the nearest package.json above the entry file.
  version?: string
  run: (args: string[]) => Promise<number>
  redact?: (text: string) => string
  usage?: false
}

// Parses a module's own arguments through runMain's handling, for a script running at its top level: the parsed values come back, and the process ends itself on --help, --version, `__complete` or an error, with the exit code runMain gives.
export async function mainArgs<T>(main: Omit<Main, 'run'>, parseArgv: (args: string[]) => T, argv = scriptArgs()): Promise<T> {
  let parsed: { value: T } | undefined
  // eslint-disable-next-line ts/require-await -- commands are async by contract
  const code = await runMain({ ...main, run: async (args) => {
    parsed = { value: parseArgv(args) }

    return 0
  } }, argv)

  if (parsed === undefined)
    process.exit(code)

  return parsed.value
}

// Runs a CLI that is a single command: `--version` or `-v` alone prints the version, an `Exit` or any error prints as `error: <name>: <message>`. Returns the exit code.
export async function runMain({ name, version, run, redact, usage }: Main, argv = scriptArgs()): Promise<number> {
  const answered = await askpassClient(argv)

  if (answered !== undefined)
    return answered

  if (argv[0] === COMPLETE)
    return printCandidates(leafCandidates(run, argv.slice(1)))

  if (argv[0] === COMPLETIONS || argv[0]?.startsWith(`${COMPLETIONS}=`) === true)
    return printCompletionScript(name, flagValue(argv), printError)

  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    console.log(version ?? packageVersion())

    return 0
  }

  let code: number
  let meta = false
  const started = performance.now()

  heading.bin = { name, version: () => version ?? packageVersion() }

  try {
    code = await run(argv)
  }
  catch (error) {
    meta = error instanceof HelpShown
    code = reportThrown(name, error, redact, wantsJson(argv))
  }
  finally {
    heading.bin = undefined
  }

  notifyEnd(name, code, performance.now() - started)

  if (usage !== false && !meta) {
    try {
      recordUsage(usageEntry(name, undefined, argv, code, { ms: performance.now() - started, mode: outputMode() }))
    }
    catch {}
  }

  return code
}
