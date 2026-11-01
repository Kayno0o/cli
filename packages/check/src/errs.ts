import type { ToolError } from './output'
import { relative } from 'node:path'
import process from 'node:process'
import { fail, jsonOption, parse, printJson, runCommand, stripAnsi, warn } from '@kaynooo/cli-kit'
import { saveLog } from '@kaynooo/out-tools/src/logs.ts'
import { parseErrors } from './output'

const usage = `errs [options] [log]
errs [options] -- <command> [args...]

Prints one \`file:line:col: message (rule)\` line per error found in a tsc, tsgo, vue-tsc, bun check, eslint, keslint or bun test log, read from the file given, from stdin (no argument or -), or from the output of the command run after --.
The lines no format recognised are counted on stderr, never dropped silently, and a command's full output is saved to a log file whose path is printed with that count.
Exits 0 when no error was found and the command, if any, passed, 1 when errors were found or the command failed, 2 on a usage error.
--json prints {errors: [{tool, file, line, column, rule, severity, message, test?}], unrecognised, log?, code?}.`

const options = {
  json: jsonOption(),
} as const

// The path as the repo sees it, absolute paths under the current folder made relative.
function display(file: string, cwd: string): string {
  const path = file.startsWith('/') ? relative(cwd, file) : file

  return path.startsWith('..') ? file : path
}

export function formatError(error: ToolError, cwd: string): string {
  const where = `${display(error.file, cwd)}:${error.line}:${error.column}`
  const label = error.test === undefined ? '' : `${error.test}: `
  const level = error.severity === 'warning' ? 'warning: ' : ''
  const rule = error.rule === undefined ? '' : ` (${error.rule})`

  return `${where}: ${level}${label}${error.message}${rule}`
}

// The log named by a lone argument (- for stdin, none for stdin too), or the output of the command to run.
async function readInput(command: string[], run: boolean): Promise<{ text: string, log?: string, code?: number }> {
  const [path] = command

  if (!run && (path === undefined || path === '-'))
    return { text: await Bun.stdin.text() }

  if (!run && path !== undefined)
    return { text: await Bun.file(path).text(), log: path }

  if (path === undefined)
    fail('give the command after --')

  let ran

  try {
    ran = await runCommand(command, { env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
  }
  catch (error) {
    fail(`cannot run ${command[0]}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return { text: stripAnsi(ran.text), log: await saveLog(ran.output), code: ran.code }
}

// Parses the log or command output into error lines; returns 1 when it found errors or the command failed.
export async function errs(args: string[], cwd = process.cwd()): Promise<number> {
  // Bun drops a leading `--` before the script sees it, so a first word that is neither an option nor an existing file starts the command.
  const first = args[0]
  const bare = first !== undefined && !first.startsWith('-') && !await Bun.file(first).exists()
  const parsed = parse(bare ? [] : args, usage, options, { rest: true })

  if (parsed.positionals.length > 1)
    fail(`give one log, or a command after --\n\n${usage}`)

  const input = await readInput(bare ? args : parsed.rest ?? parsed.positionals, bare || parsed.rest !== undefined)
  const { errors, unrecognised } = parseErrors(input.text)

  if (parsed.values.json === true) {
    printJson({ errors, unrecognised, ...(input.log === undefined ? {} : { log: input.log }), ...(input.code === undefined ? {} : { code: input.code }) })
  }
  else {
    for (const error of errors)
      console.log(formatError(error, cwd))

    if (unrecognised > 0)
      warn(`${unrecognised} ${unrecognised === 1 ? 'line' : 'lines'} not recognised`, input.log === undefined ? undefined : `see ${input.log}`)

    if (errors.length === 0 && input.code !== undefined && input.code !== 0)
      warn(`the command exited ${input.code} with no error recognised`, input.log === undefined ? undefined : `see ${input.log}`)
  }

  return errors.length > 0 || (input.code ?? 0) !== 0 ? 1 : 0
}
