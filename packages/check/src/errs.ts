import type { ExitRow } from '@kaynooo/cli-kit'
import type { PlaceSettings } from './compose'
import type { ToolError } from './output'
import { relative } from 'node:path'
import process from 'node:process'
import { fail, holdSignals, jsonOption, paint, parse, printJson, readInput as readText, role, runCommand, stripAnsi, warn } from '@kaynooo/cli-kit'
import { argvIn, place, placeOptions, placeSettings, Stack } from './compose'
import { formatError, parseErrors } from './output'
import { saveLog } from './run'

export { formatError }

const usage = `errs [options] [log]
errs [options] -- <command> [args...]
errs --in <service> | --host -- <command> [args...]

Prints one \`file:line:col: message (rule)\` line per error found in a tsc, eslint, bun test, vitest, playwright, phpunit, phpstan, php-cs-fixer, go, cargo, ruff or pytest log, or any \`file:line[:col]: error|warning: message\` line, read from a file, from stdin or from the output of the command run after --.
The lines no format recognised are counted on stderr, never dropped, and a command's full output is saved to a log file whose path is printed with that count.
A command runs inside the running compose service that bind-mounts the current folder and never starts one; --in picks the service, --host forces the host.`

const EXITS: ExitRow[] = [[0, 'no error was found and the command, if any, passed'], [1, 'errors were found or the command failed'], [2, 'a usage error']]

const options = {
  ...placeOptions,
  'severity': { type: 'string', choices: ['error', 'warning'] as const, description: 'show only errors or only warnings' },
  'group-by': { type: 'string', choices: ['file', 'rule'] as const, description: 'group diagnostics by file or rule' },
  'summary': { type: 'boolean', description: 'print counts by severity, file and rule instead of every line' },
  'unrecognised': { type: 'boolean', short: 'u', description: 'also print lines no parser recognised' },
  'json': jsonOption('{errors: [{tool, file, line, column, rule, severity, message, test?}], unrecognised, unrecognisedLines?, log?, code?}'),
} as const

// The path as the repo sees it, absolute paths under the current folder made relative.
function display(file: string, cwd: string): string {
  const path = file.startsWith('/') ? relative(cwd, file) : file

  return path.startsWith('..') ? file : path
}

function printGrouped(errors: readonly ToolError[], by: 'file' | 'rule', cwd: string): void {
  const groups = new Map<string, ToolError[]>()

  for (const error of errors) {
    const key = by === 'file' ? display(error.file, cwd) : (error.rule ?? '(no rule)')
    const list = groups.get(key) ?? []

    list.push(error)
    groups.set(key, list)
  }

  const head = role(by === 'file' ? 'path' : 'id', process.stdout)
  const { dim } = paint(process.stdout)

  for (const [key, list] of [...groups.entries()].toSorted((a, b) => b[1].length - a[1].length)) {
    console.log(`${head(key)} ${dim(`(${list.length})`)}`)

    for (const error of list)
      console.log(`  ${formatError(error, cwd)}`)
  }
}

function printSummary(errors: readonly ToolError[], cwd: string): void {
  const errCount = errors.filter(e => e.severity === 'error').length
  const warnCount = errors.filter(e => e.severity === 'warning').length
  const files = new Set(errors.map(e => display(e.file, cwd))).size
  const byRule = new Map<string, number>()

  for (const error of errors) {
    const rule = error.rule ?? error.tool

    byRule.set(rule, (byRule.get(rule) ?? 0) + 1)
  }

  console.log(`${errCount} ${errCount === 1 ? 'error' : 'errors'}, ${warnCount} ${warnCount === 1 ? 'warning' : 'warnings'} across ${files} ${files === 1 ? 'file' : 'files'}`)

  for (const [rule, count] of [...byRule.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 10))
    console.log(`  ${String(count).padStart(4)}  ${rule}`)
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
  // Bun drops a leading `--` before the script sees it, so a first word that is an executable on PATH (not a missing log filename) starts a bare command.
  const first = args[0]
  const bare = first !== undefined && !first.startsWith('-') && !await Bun.file(first).exists() && Bun.which(first) !== null
  const parsed = parse(bare ? [] : args, usage, options, { exits: EXITS, rest: true, replaces: 'reading raw tsc, eslint, phpunit, phpstan or playwright logs, or grepping a test summary out of them', examples: [['errs -- bun run check', 'the type errors of a run'], ['bun test 2>&1 | errs', 'the failed tests from stdin'], ['errs -- vendor/bin/phpunit', 'each failed PHP test with its file and line']] })

  if (parsed.positionals.length > 1)
    fail(`give one log, or a command after --\n\n${usage}`)

  const input = await readInput(bare ? args : parsed.rest ?? parsed.positionals, bare || parsed.rest !== undefined, placeSettings(parsed.values), cwd)
  const { errors: allErrors, unrecognised, unrecognisedLines } = parseErrors(input.text)
  const errors = parsed.values.severity === undefined ? allErrors : allErrors.filter(error => error.severity === parsed.values.severity)

  if (parsed.values.json === true) {
    printJson({
      errors,
      unrecognised,
      ...(parsed.values.unrecognised === true ? { unrecognisedLines } : {}),
      ...(input.log === undefined ? {} : { log: input.log }),
      ...(input.code === undefined ? {} : { code: input.code }),
    })
  }
  else {
    if (parsed.values.summary === true) {
      printSummary(errors, cwd)
    }
    else if (parsed.values['group-by'] !== undefined) {
      printGrouped(errors, parsed.values['group-by'], cwd)
    }
    else {
      for (const error of errors)
        console.log(formatError(error, cwd))
    }

    if (parsed.values.unrecognised === true && unrecognisedLines.length > 0) {
      console.log(`\n-- unrecognised (${unrecognisedLines.length}) --`)

      for (const line of unrecognisedLines)
        console.log(line)
    }
    else if (unrecognised > 0) {
      warn(`${unrecognised} ${unrecognised === 1 ? 'line' : 'lines'} not recognised`, input.log === undefined ? undefined : `see ${input.log}`)
    }

    if (errors.length === 0 && input.code !== undefined && input.code !== 0)
      warn(`the command exited ${input.code} with no error recognised`, input.log === undefined ? undefined : `see ${input.log}`)
  }

  return errors.length > 0 || (input.code ?? 0) !== 0 ? 1 : 0
}
