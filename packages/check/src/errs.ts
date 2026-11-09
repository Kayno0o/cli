import type { ExitRow } from '@kaynooo/cli-kit'
import type { PlaceSettings } from './compose'
import type { ToolError } from './output'
import { relative } from 'node:path'
import process from 'node:process'
import { fail, holdSignals, jsonOption, parse, printJson, readInput as readText, runCommand, stripAnsi, warn } from '@kaynooo/cli-kit'
import { argvIn, place, placeOptions, placeSettings, Stack } from './compose'
import { parseErrors } from './output'
import { saveLog } from './run'

const usage = `errs [options] [log]
errs [options] -- <command> [args...]
errs --in <service> | --host -- <command> [args...]

Prints one \`file:line:col: message (rule)\` line per error found in a tsc, tsgo, vue-tsc, bun check, kay check, eslint, keslint, bun test, vitest, playwright (list and line reporters), phpunit, paratest, phpstan (table, raw and json), php-cs-fixer, go (build, vet), cargo (rustc), ruff (concise and full) or pytest log, or any line shaped \`file:line[:col]: error|warning: message\` (mypy, gcc, clang, \`shellcheck -f gcc\`, golangci-lint), read from the file given, from stdin (no argument or -), or from the output of the command run after --.
The lines no format recognised are counted on stderr, never dropped silently, and a command's full output is saved to a log file whose path is printed with that count.
A command runs inside the docker compose service that bind-mounts the current folder (found in compose.yml, compose.yaml or docker-compose.yml, up to the repository root), at the matching path, with its output read here; a service that is down is never started, the call fails naming it. --in picks the service, --host forces the host.
--json prints {errors: [{tool, file, line, column, rule, severity, message, test?}], unrecognised, log?, code?}, tool one of tsc, eslint, bun check, kay check, bun test, vitest, playwright, phpunit, phpstan, php-cs-fixer, go, cargo, ruff, pytest, generic. An error repeated with the same file, position and message is printed once.`

const EXITS: ExitRow[] = [[0, 'no error was found and the command, if any, passed'], [1, 'errors were found or the command failed'], [2, 'a usage error']]

const options = {
  ...placeOptions,
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
async function readInput(command: string[], run: boolean, settings: PlaceSettings, cwd: string): Promise<{ text: string, log?: string, code?: number }> {
  const [path] = command

  if (!run && (settings.service !== undefined || settings.host === true))
    fail('--in and --host apply to a command run after --')

  if (!run && (path === undefined || path === '-'))
    return { text: await readText('-', { noStdin: 'give a log, a command after --, or pipe the output on stdin' }) }

  if (!run && path !== undefined)
    return { text: await readText(path), log: path }

  if (path === undefined)
    fail('give the command after --')

  const placement = await place(cwd, path, settings)
  const down = placement === undefined ? undefined : await new Stack().problem(placement)

  if (down !== undefined)
    fail(down, 1)

  const held = holdSignals()
  let ran

  try {
    ran = await runCommand(placement === undefined ? command : argvIn(placement, command), { ...(placement === undefined ? {} : { cwd: placement.composeDir }), env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, onStart: child => held.forward(child) })
  }
  catch (error) {
    fail(`cannot run ${command[0]}: ${error instanceof Error ? error.message : String(error)}`)
  }
  finally {
    held.release()
  }

  return { text: stripAnsi(ran.text), log: await saveLog(ran.output), code: ran.code }
}

// Parses the log or command output into error lines; returns 1 when it found errors or the command failed.
export async function errs(args: string[], cwd = process.cwd()): Promise<number> {
  // Bun drops a leading `--` before the script sees it, so a first word that is neither an option nor an existing file starts the command.
  const first = args[0]
  const bare = first !== undefined && !first.startsWith('-') && !await Bun.file(first).exists()
  const parsed = parse(bare ? [] : args, usage, options, { exits: EXITS, rest: true, replaces: 'reading raw tsc, eslint, phpunit, phpstan or playwright logs, or grepping a test summary out of them', examples: [['errs -- bun run check', 'the type errors of a run'], ['bun test 2>&1 | errs', 'the failed tests from stdin'], ['errs -- vendor/bin/phpunit', 'each failed PHP test with its file and line']] })

  if (parsed.positionals.length > 1)
    fail(`give one log, or a command after --\n\n${usage}`)

  const input = await readInput(bare ? args : parsed.rest ?? parsed.positionals, bare || parsed.rest !== undefined, placeSettings(parsed.values), cwd)
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
