#!/usr/bin/env bun

import process from 'node:process'
import { fail, holdSignals, jsonOption, parse, printJson, runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { checkout, inWorktree, keptPaths, resolveRef, runIn, runsInContainer, shellCommand } from './worktree'

const USAGE = 'proof [--ref <rev>] [--keep <path>...] [--no-link] [--json] -- <command> [args...]: runs the command at HEAD or another ref in a temporary worktree, then in the working tree, to show that a test fails before a change and passes after it\n\nExits 0 when the command fails before and passes now, 1 when it passes before too, fails now too, or passes before and fails now, 2 on a usage error, an unknown ref or a command that cannot start.'

const OPTIONS = {
  'ref': { type: 'string', short: 'r', description: 'the commit to run before at (default HEAD)' },
  'keep': { type: 'string', short: 'k', multiple: true, description: 'a working-tree file or folder copied over to the ref, such as the new test, repeatable' },
  'no-link': { type: 'boolean', description: 'do not link the ignored env files, node_modules, vendor and .venv of the checkout' },
  'json': jsonOption('{outcome, proved, ref, sha, before: {code, output}, now: {code, output}}'),
} as const

type Outcome = 'proved' | 'passes-before' | 'fails-both' | 'regressed'

function outcomeOf(before: number, now: number): Outcome {
  if (before !== 0 && now === 0)
    return 'proved'

  if (before === 0 && now === 0)
    return 'passes-before'

  return before !== 0 ? 'fails-both' : 'regressed'
}

// The message of each outcome and the side whose output explains it.
function describe(outcome: Outcome, at: string): { message: string, side: 'before' | 'now' } {
  switch (outcome) {
    case 'proved': return { message: `fails at ${at}, passes now`, side: 'before' }
    case 'passes-before': return { message: `passes at ${at} too: it does not fail without the change`, side: 'before' }
    case 'fails-both': return { message: `fails at ${at} and fails now too`, side: 'now' }
    case 'regressed': return { message: `passes at ${at}, fails now`, side: 'now' }
  }
}

async function main(argv: string[]): Promise<number> {
  // Bun drops a leading `--` before the script sees it, so a first word that is no option starts the command.
  const bare = argv[0] !== undefined && !argv[0].startsWith('-')
  const parsed = parse(bare ? [] : argv, USAGE, OPTIONS, { rest: true })

  const given = bare ? argv : parsed.rest ?? []

  if (given.length === 0 || parsed.positionals.length > 0)
    fail(`give the command after --\n\n${USAGE}`)

  if (runsInContainer(given))
    fail('a container of the compose project mounts the main checkout, not the temporary worktree, so the command would not run at the ref: run the tool on the host, or check the ref out by hand')

  const command = shellCommand(given)
  const cwd = process.cwd()
  const { root, prefix } = await checkout(cwd)
  const ref = parsed.values.ref ?? 'HEAD'
  const sha = await resolveRef(root, ref)
  const kept = keptPaths(root, cwd, parsed.values.keep ?? [])

  const before = await inWorktree({ root, prefix, sha, ref, kept, link: parsed.values['no-link'] !== true }, async (runDir, signals) => runIn(runDir, command, signals, true))

  if (!before.started)
    fail(before.output)

  const signals = holdSignals()
  const now = await runIn(cwd, command, signals, true)

  signals.release()

  if (!now.started)
    fail(now.output)

  const outcome = outcomeOf(before.code, now.code)
  const { message, side } = describe(outcome, sha.slice(0, 7))
  const proved = outcome === 'proved'

  if (parsed.values.json === true) {
    printJson({ outcome, proved, ref, sha, before: { code: before.code, output: before.output }, now: { code: now.code, output: now.output } })

    return proved ? 0 : 1
  }

  console.log(message)

  const shown = side === 'before' ? before : now

  if (shown.code !== 0 && shown.output.trim() !== '')
    console.log(`\n${shown.output.trimEnd()}`)

  return proved ? 0 : 1
}

process.exitCode = await runMain({ name: 'proof', version, run: main })
