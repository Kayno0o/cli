import process from 'node:process'
import { Exit } from './args'
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
  header: string
  commands: Record<string, Command>
  aliases: Record<string, string> | undefined
  defaultCommand: string | undefined
}

function help({ path, header, commands }: Level): string {
  const width = Math.max(...Object.keys(commands).map(name => name.length))
  const prefix = path.join(' ')

  return [
    header,
    '',
    `usage: ${prefix} <command> [options], ${prefix} <command> --help for its options`,
    '',
    ...Object.entries(commands).map(([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}`),
  ].join('\n')
}

async function dispatch(level: Level, argv: string[], version: string): Promise<number> {
  const [name, ...args] = argv
  const prefix = level.path.join(' ')

  if (name === undefined && level.path.length > 1) {
    console.error(help(level))

    return 2
  }

  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    console.log(help(level))

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

    console.error(meant === undefined ? `${prefix}: no command ${name}\n\n${help(level)}` : `${prefix}: no command ${name}, did you mean ${meant}?`)

    return 2
  }

  if ('commands' in command)
    return dispatch({ path: [...level.path, name], header: `${prefix} ${name}: ${command.summary}`, commands: command.commands, aliases: command.aliases, defaultCommand: undefined }, rest, version)

  try {
    return await command.run(rest)
  }
  catch (error) {
    console.error(`${prefix} ${name}: ${error instanceof Error ? error.message : String(error)}`)

    return error instanceof Exit ? error.code : 1
  }
}

// Runs the command argv names and returns the exit code: 0 for help and version, 2 for an unknown command.
export async function runCli(cli: Cli, argv = process.argv.slice(2)): Promise<number> {
  return dispatch({ path: [cli.name], header: `${cli.name} ${cli.version}: ${cli.about}`, commands: cli.commands, aliases: cli.aliases, defaultCommand: cli.defaultCommand }, argv, cli.version)
}

export interface Main {
  name: string
  version: string
  run: (args: string[]) => Promise<number>
}

// Runs a CLI that is a single command: `--version` or `-v` alone prints the version, an `Exit` or any error prints `<name>: <message>`. Returns the exit code.
export async function runMain({ name, version, run }: Main, argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
    console.log(version)

    return 0
  }

  try {
    return await run(argv)
  }
  catch (error) {
    console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`)

    return error instanceof Exit ? error.code : 1
  }
}
