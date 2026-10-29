import type { Outcome } from './run'
import type { Step } from './steps'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fail, parse, table } from '@kaynooo/cli-kit'
import { changedFiles, dirtyFiles } from './changes'
import { pick } from './check'
import { declarePhony } from './makefile'
import { logDirectory, printOutcome, runStep } from './run'
import { candidates, read } from './steps'

const usage = `fix [--only <fixers>] [--list]

Runs the folder's fixers: the project's own \`fix\` script, else its \`lint:fix\` and \`format\` ones (package.json through bun run, composer.json, a Justfile or a Makefile), then the formatters its files call for: just --fmt, go fmt and go mod tidy, cargo fmt, ruff where configured, and every Makefile target declared .PHONY.
It looks at the folder itself only, so each package of a monorepo gets its own run.
Prints one line per fixer, what a failing one said, then the files the run changed. Each fixer's full output is saved to the file whose path ends its line.
Exits 0 when every fixer ran, 1 when one failed, 2 on bad usage or when nothing applies.`

const options = {
  list: { type: 'boolean', short: 'l', description: 'print the fixers that apply and the commands that run them, without running them' },
  only: { type: 'string', short: 'o', description: 'comma separated fixers to run, by the names --list prints' },
} as const

export interface Fixer extends Step {
  // The binary it runs, skipped with a note when missing.
  requires?: string
  // Rewrites files itself instead of running the command, which then only describes it.
  write?: (dir: string) => Promise<string>
}

// Set for the fixers' commands, so a fix script calling this bin again fails instead of recursing.
const RUNNING = 'AGENT_TOOLS_FIX'
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile']
const JUSTFILES = ['justfile', 'Justfile', '.justfile']
const RUFF_CONFIGS = ['ruff.toml', '.ruff.toml']
const RUFF_SECTION = /^\[tool\.ruff/m
const MAX_CHANGED = 30

async function firstFile(dir: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    if (await Bun.file(join(dir, name)).exists())
      return name
  }

  return undefined
}

// The project's own fix script, recipe or target when it has one, else its lint:fix and format ones.
async function projectFixers(dir: string): Promise<Fixer[]> {
  const found = await candidates(dir, 'fix')
  const named = (name: string) => found.find(step => step.name === name)
  const all = named('fix')

  if (all !== undefined)
    return [all]

  return [named('lint:fix') ?? named('lint-fix'), named('format')].filter(step => step !== undefined)
}

async function toolFixers(dir: string): Promise<Fixer[]> {
  const fixers: Fixer[] = []
  const makefile = await firstFile(dir, MAKEFILES)
  const justfile = await firstFile(dir, JUSTFILES)
  const ruff = await firstFile(dir, RUFF_CONFIGS) !== undefined || RUFF_SECTION.test(await read(dir, 'pyproject.toml') ?? '')

  if (makefile !== undefined) {
    fixers.push({ name: 'makefile', command: 'declare every target .PHONY', source: makefile, write: async (cwd) => {
      const file = Bun.file(join(cwd, makefile))
      const { content, targets } = declarePhony(await file.text())

      await Bun.write(file, content)

      return `.PHONY: ${targets.join(' ')}`
    } })
  }

  // Without --justfile, just would climb to a parent folder's justfile.
  if (justfile !== undefined)
    fixers.push({ name: 'justfile', command: `just --justfile ${justfile} --fmt`, source: justfile, requires: 'just' })

  if (await Bun.file(join(dir, 'go.mod')).exists())
    fixers.push({ name: 'go', command: 'go fmt ./... && go mod tidy', source: 'go.mod', requires: 'go' })

  if (await Bun.file(join(dir, 'Cargo.toml')).exists())
    fixers.push({ name: 'rust', command: 'cargo fmt', source: 'Cargo.toml', requires: 'cargo' })

  if (ruff)
    fixers.push({ name: 'python', command: 'ruff check --fix . && ruff format .', source: 'ruff', requires: 'ruff' })

  return fixers
}

export async function fixers(dir: string): Promise<Fixer[]> {
  return [...await projectFixers(dir), ...await toolFixers(dir)]
}

async function runFixer(fixer: Fixer, cwd: string, logFile: string): Promise<Outcome> {
  if (fixer.write === undefined)
    return runStep(fixer.command, cwd, logFile, { [RUNNING]: '1' })

  const started = Date.now()
  let outcome: Outcome

  try {
    outcome = { ok: true, ms: 0, output: await fixer.write(cwd) }
  }
  catch (error) {
    outcome = { ok: false, ms: 0, output: error instanceof Error ? error.message : String(error) }
  }

  await Bun.write(logFile, outcome.output)

  return { ...outcome, ms: Date.now() - started }
}

function printChanged(changed: string[]): void {
  if (changed.length === 0) {
    console.log('nothing changed')

    return
  }

  console.log(`changed ${changed.length} file${changed.length === 1 ? '' : 's'}:`)

  for (const path of changed.slice(0, MAX_CHANGED))
    console.log(`  ${path}`)

  if (changed.length > MAX_CHANGED)
    console.log(`  and ${changed.length - MAX_CHANGED} more`)
}

// Runs the folder's fixers in order, one line each with what failed under a failing one, then lists the files they changed; returns 0 only when every fixer ran.
export async function fix(args: string[], cwd = process.cwd()): Promise<number> {
  const parsed = parse(args, usage, options)

  if (parsed === undefined)
    return 0

  if (process.env[RUNNING] !== undefined)
    fail('a fixer called fix again, which would recurse: give its script another command')

  const found = await fixers(cwd)

  if (found.length === 0)
    fail('nothing to fix here: no fix, lint:fix or format script, Makefile, Justfile, go.mod, Cargo.toml nor ruff config')

  const picked = pick(found, parsed.values.only)

  if (parsed.values.list === true) {
    console.log(table(picked.map(fixer => [fixer.name, fixer.command, fixer.requires !== undefined && Bun.which(fixer.requires) === null ? `${fixer.source}, needs ${fixer.requires}` : fixer.source])))

    return 0
  }

  const directory = logDirectory(cwd)

  await mkdir(directory, { recursive: true })

  const width = Math.max(...picked.map(fixer => fixer.name.length))
  const before = await dirtyFiles(cwd)
  let failed = 0

  for (const fixer of picked) {
    if (fixer.requires !== undefined && Bun.which(fixer.requires) === null) {
      console.log(`skip  ${fixer.name.padEnd(width)}  ${fixer.requires} is not installed`)

      continue
    }

    const logFile = join(directory, `fix-${fixer.name.replaceAll(':', '-')}.log`)
    const outcome = await runFixer(fixer, cwd, logFile)

    printOutcome(fixer.name, width, fixer.command, logFile, outcome)

    if (!outcome.ok)
      failed++
  }

  const after = before && await dirtyFiles(cwd)

  if (before !== undefined && after !== undefined)
    printChanged(changedFiles(before, after))

  return failed === 0 ? 0 : 1
}
