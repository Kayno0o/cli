import process from 'node:process'
import { Exit } from './args'

export interface Command {
  run: (args: string[]) => Promise<number>
  summary: string
}

export interface Cli {
  name: string
  version: string
  // One line after `<name> <version>: ` in the help.
  about: string
  commands: Record<string, Command>
  // Names sessions reach for that mean an existing command.
  aliases?: Record<string, string>
}

// Edit distance between two names, for pointing a mistyped command at the one meant.
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (const [i, left] of [...a].entries()) {
    const current = [i + 1]

    for (const [j, right] of [...b].entries())
      current.push(Math.min((previous[j + 1] ?? 0) + 1, (current[j] ?? 0) + 1, (previous[j] ?? 0) + (left === right ? 0 : 1)))

    previous = current
  }

  return previous[b.length] ?? 0
}

// A command the name starts, else one within two edits (one for a name under four letters).
export function closest(name: string, names: string[]): string | undefined {
  const started = names.find(known => known.startsWith(name))

  if (started !== undefined)
    return started

  const [best] = names.map(known => ({ known, far: distance(name, known) })).sort((a, b) => a.far - b.far)

  return best !== undefined && best.far <= (name.length < 4 ? 1 : 2) ? best.known : undefined
}

function help(cli: Cli): string {
  const width = Math.max(...Object.keys(cli.commands).map(name => name.length))

  return [
    `${cli.name} ${cli.version}: ${cli.about}`,
    '',
    `usage: ${cli.name} <command> [options], ${cli.name} <command> --help for its options`,
    '',
    ...Object.entries(cli.commands).map(([name, { summary }]) => `  ${name.padEnd(width)}  ${summary}`),
  ].join('\n')
}

// Runs the command argv names and returns the exit code: 0 for help and version, 2 for an unknown command.
export async function runCli(cli: Cli, argv = process.argv.slice(2)): Promise<number> {
  const [name, ...args] = argv

  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    console.log(help(cli))

    return 0
  }

  if (name === '--version' || name === '-v') {
    console.log(cli.version)

    return 0
  }

  const command = cli.commands[cli.aliases?.[name] ?? name]

  if (command === undefined) {
    const meant = closest(name, Object.keys(cli.commands))

    console.error(meant === undefined ? `${cli.name}: no command ${name}\n\n${help(cli)}` : `${cli.name}: no command ${name}, did you mean ${meant}?`)

    return 2
  }

  try {
    return await command.run(args)
  }
  catch (error) {
    console.error(`${cli.name} ${name}: ${error instanceof Error ? error.message : String(error)}`)

    return error instanceof Exit ? error.code : 1
  }
}
