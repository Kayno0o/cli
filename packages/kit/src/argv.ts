import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

// The command line the kernel kept for this process, none without /proc.
function commandLine(): string[] | undefined {
  try {
    return readFileSync('/proc/self/cmdline', 'utf8').split('\0').slice(0, -1)
  }
  catch {
    return undefined
  }
}

/**
 * The arguments after the script, with the `--` Bun drops when it comes right after the script put back: `gp -- --tags` reaches the script as `--tags` (Bun 1.4), which would read as one of its own options.
 * The command line the kernel kept tells; a compiled binary or a system without /proc gets Bun's arguments.
 */
export function scriptArgs(argv = process.argv.slice(2), cmdline = commandLine(), script = process.argv[1]): string[] {
  const at = cmdline === undefined || script === undefined ? -1 : cmdline.findIndex((word, index) => index > 0 && resolve(word) === script)
  const after = at === -1 ? [] : cmdline!.slice(at + 1)

  return after[0] === '--' && after.length === argv.length + 1 && argv.every((word, index) => word === after[index + 1]) ? after : argv
}
