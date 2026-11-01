#!/usr/bin/env bun

import type { Subprocess } from 'bun'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { exitCodeOf, fail, parse, runMain } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { addWorktree, checkout, copyKept, keptPaths, linkedEntries, linkEntries, removeWorktree, resolveRef, runsInContainer } from './worktree'

const USAGE = 'base [--ref <rev>] [--keep <path>...] [--no-link] -- <command> [args...]: runs the command at HEAD or another ref in a temporary worktree, the working tree untouched, exiting with its code'

const OPTIONS = {
  'ref': { type: 'string', short: 'r', description: 'the commit to run at (default HEAD)' },
  'keep': { type: 'string', short: 'k', multiple: true, description: 'a working-tree file or folder copied over, such as the new test, repeatable' },
  'no-link': { type: 'boolean', description: 'do not link the ignored env files, node_modules, vendor and .venv of the checkout' },
} as const

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

const WHITESPACE = /\s/

// Signals are held from the worktree's creation to its removal: one arriving before the command starts skips it, one during it is passed on to it.
const running: { child?: Subprocess, signal?: NodeJS.Signals } = {}

function forward(signal: NodeJS.Signals) {
  running.signal = signal
  running.child?.kill(signal)
}

async function runIn(dir: string, command: string[]): Promise<number> {
  if (running.signal !== undefined)
    return exitCodeOf(null, running.signal)

  try {
    running.child = Bun.spawn(command, { cwd: dir, stdio: ['inherit', 'inherit', 'inherit'] })
  }
  catch (error) {
    console.error(`base: cannot run ${command[0]}: ${error instanceof Error ? error.message : String(error)}`)

    return 127
  }

  await running.child.exited

  return exitCodeOf(running.child.exitCode, running.child.signalCode ?? null)
}

async function main(argv: string[]): Promise<number> {
  // Bun drops a leading `--` before the script sees it, so a first word that is no option starts the command.
  const bare = argv[0] !== undefined && !argv[0].startsWith('-')
  const parsed = parse(bare ? [] : argv, USAGE, OPTIONS, { rest: true })

  const given = bare ? argv : parsed.rest ?? []

  if (given.length === 0 || parsed.positionals.length > 0)
    fail(`give the command after --\n\n${USAGE}`)

  // One argument holding spaces is a shell line, `base -- 'bun test a | tail'`.
  const command = given.length === 1 && WHITESPACE.test(given[0] as string) ? ['sh', '-c', given[0] as string] : given

  if (runsInContainer(given))
    fail('a container of the compose project mounts the main checkout, not the temporary worktree, so the command would not run at the ref: run the tool on the host, or check the ref out by hand')

  const cwd = process.cwd()
  const { root, prefix } = await checkout(cwd)
  const ref = parsed.values.ref ?? 'HEAD'
  const sha = await resolveRef(root, ref)
  const kept = keptPaths(root, cwd, parsed.values.keep ?? [])
  let links: string[] = []
  let code: number

  for (const signal of SIGNALS)
    process.on(signal, forward)

  const dir = await addWorktree(root, sha)

  try {
    copyKept(root, dir, kept)
    links = parsed.values['no-link'] === true ? [] : linkEntries(root, dir, await linkedEntries(root))

    const runDir = join(dir, prefix)

    if (!existsSync(runDir))
      fail(`${prefix} does not exist at ${ref}`)

    code = await runIn(runDir, command)
  }
  finally {
    await removeWorktree(root, dir, links)

    for (const signal of SIGNALS)
      process.off(signal, forward)
  }

  console.error(`base: ran at ${ref} (${sha.slice(0, 7)}), exit ${code}`)

  return code
}

process.exitCode = await runMain({ name: 'base', version, run: main })
