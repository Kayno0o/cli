import type { Options } from './args'
import type { Colors } from './style'
import process from 'node:process'
import { Completing, completion, Exit, UsageError, usageLine } from './args'
import { paint, takesControlCodes } from './style'
import { distance } from './text'

export type Command = { summary: string } & (
  | { run: (args: string[]) => Promise<number> }
  // A group of subcommands dispatched the same way, with its own help.
  | { commands: Record<string, Command>, aliases?: Record<string, string> }
)

export interface Cli {
  name: string
  version: string
  // One line after `<name> <version>: ` in the help.
  about: string
  commands: Record<string, Command>
  // Names sessions reach for that mean an existing command.
  aliases?: Record<string, string>
  // The command that takes the arguments when the first one names no command, so `db "select 1"` runs `db query "select 1"`.
  defaultCommand?: string
}

// A command the name starts, else one within two edits (one for a name under four letters).
export function closest(name: string, names: string[]): string | undefined {
  const started = names.find(known => known.startsWith(name))

  if (started !== undefined)
    return started

  const [best] = names.map(known => ({ known, far: distance(name, known) })).sort((a, b) => a.far - b.far)

  return best !== undefined && best.far <= (name.length < 4 ? 1 : 2) ? best.known : undefined
}

interface Level {
  // The words typed to reach this level, `ft plan`.
  path: string[]
  header: (colors: Colors) => string
  commands: Record<string, Command>
  aliases: Record<string, string> | undefined
  defaultCommand: string | undefined
}

function help({ path, header, commands }: Level, stream: { isTTY?: boolean }): string {
  const colors = paint(stream)
  const width = Math.max(...Object.keys(commands).map(name => name.length))
  const prefix = path.join(' ')

  return [
    header(colors),
    '',
    usageLine(`${prefix} ${colors.cyan('<command>')} [options]`, colors),
    '',
    colors.bold('Commands:'),
    ...Object.entries(commands).map(([name, { summary }]) => `  ${colors.cyan(name.padEnd(width))}  ${colors.dim(summary)}`),
    '',
    `${colors.dim('Run')} ${prefix} ${colors.cyan('<command>')} --help ${colors.dim('for its options.')}`,
  ].join('\n')
}

// `error <prefix>: <message>` on stderr, the hint on its own line under it; plain words off a terminal.
export function printError(prefix: string, message: string, hint?: string): void {
  const colors = paint(process.stderr)
  const styled = takesControlCodes(process.stderr)
  const head = styled ? `${colors.red.bold('error')} ${colors.dim(`${prefix}:`)}` : `error: ${prefix}:`

  console.error(`${head} ${message}${hint === undefined ? '' : `\n  ${styled ? colors.yellow('hint') : 'hint:'} ${hint}`}`)
}

// What a thrown error prints as and exits with: an Exit its own code and hint, a UsageError pointed at the help, anything else 1.
function reportThrown(prefix: string, error: unknown): number {
  const help = error instanceof UsageError ? `run ${prefix} --help for its options` : undefined

  printError(prefix, error instanceof Error ? error.message : String(error), error instanceof Exit ? error.hint ?? help : undefined)

  return error instanceof Exit ? error.code : 1
}

async function dispatch(level: Level, argv: string[], version: string): Promise<number> {
  const [name, ...args] = argv
  const prefix = level.path.join(' ')

  if (name === undefined && level.path.length > 1) {
    console.error(help(level, process.stderr))

    return 2
  }

  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    console.log(help(level, process.stdout))

    return 0
  }

  if (level.path.length === 1 && (name === '--version' || name === '-v')) {
    console.log(version)

    return 0
  }

  let command = level.commands[level.aliases?.[name] ?? name]
  let rest = args

  if (command === undefined && level.defaultCommand !== undefined) {
    command = level.commands[level.defaultCommand]
    rest = argv
  }

  if (command === undefined) {
    const meant = closest(name, Object.keys(level.commands))

    printError(prefix, `no command ${name}`, meant === undefined ? `run ${prefix} --help for its commands` : `did you mean ${meant}?`)

    return 2
  }

  if ('commands' in command) {
    const { summary } = command

    return dispatch({ path: [...level.path, name], header: colors => `${colors.bold(`${prefix} ${name}`)}  ${summary}`, commands: command.commands, aliases: command.aliases, defaultCommand: undefined }, rest, version)
  }

  try {
    return await command.run(rest)
  }
  catch (error) {
    return reportThrown(`${prefix} ${name}`, error)
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

// A leaf command's candidates: its long options for a word starting with a dash, else paths.
async function leafCandidates(run: (args: string[]) => Promise<number>, words: string[]): Promise<string[]> {
  if (!(words.at(-1) ?? '').startsWith('-'))
    return [FILES]

  return Object.entries(await optionsOf(run)).map(([name, option]) => `--${name}\t${option.description}`)
}

// The candidates for the last word, `value\tdescription` per line, after walking the subcommands the earlier words name.
async function candidates(commands: Record<string, Command>, aliases: Record<string, string> | undefined, defaultCommand: string | undefined, words: string[]): Promise<string[]> {
  const [word = '', ...rest] = words
  const command = commands[aliases?.[word] ?? word]

  if (rest.length === 0 && !word.startsWith('-'))
    return Object.entries(commands).map(([name, { summary }]) => `${name}\t${summary}`)

  if (command === undefined) {
    const fallback = defaultCommand === undefined ? undefined : commands[defaultCommand]

    return fallback !== undefined && 'run' in fallback ? leafCandidates(fallback.run, words) : []
  }

  return 'commands' in command ? candidates(command.commands, command.aliases, undefined, rest) : leafCandidates(command.run, rest)
}

async function printCandidates(found: Promise<string[]>): Promise<number> {
  for (const line of await found)
    console.log(line)

  return 0
}

// Runs the command argv names and returns the exit code: 0 for help and version, 2 for an unknown command.
export async function runCli(cli: Cli, argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === COMPLETE)
    return printCandidates(candidates(cli.commands, cli.aliases, cli.defaultCommand, argv.slice(1)))

  return dispatch({ path: [cli.name], header: colors => `${colors.bold(cli.name)} ${colors.dim(cli.version)}  ${cli.about}`, commands: cli.commands, aliases: cli.aliases, defaultCommand: cli.defaultCommand }, argv, cli.version)
}

export interface Main {
  name: string
  version: string
  run: (args: string[]) => Promise<number>
}

// Runs a CLI that is a single command: `--version` or `-v` alone prints the version, an `Exit` or any error prints as `error: <name>: <message>`. Returns the exit code.
export async function runMain({ name, version, run }: Main, argv = process.argv.slice(2)): Promise<number> {
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
    return reportThrown(name, error)
  }
}
