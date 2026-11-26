import type { Placement } from './compose'
import type { Outcome, StepSettings } from './run'
import type { Step } from './steps'
import { existsSync, statSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import process from 'node:process'
import { duration, exitCodeOf, fail, holdSignals, paint, printJson, table } from '@kaynooo/cli-kit'
import { changedFiles, dirtyFiles } from './changes'
import { place, placeSettings, programOf, shellIn, Stack } from './compose'
import { declarePhony } from './makefile'
import { changedPaths } from './narrow'
import { pick } from './options'
import { logDirectory, outcomeJson, printOutcome, refusedStep, runStep } from './run'
import { candidates, CS_FIXER_CONFIGS, firstFile, MAKEFILES, read } from './steps'

export interface FixValues { list?: boolean | undefined, only?: string | undefined, timeout?: string | undefined, in?: string | undefined, host?: boolean | undefined, json?: boolean | undefined, changed?: boolean | undefined, base?: string | undefined }

export interface Fixer extends Step {
  // The binary it runs, skipped with a note when missing.
  requires?: string
  // Rewrites files itself instead of running the command, which then only describes it.
  write?: (dir: string) => Promise<string>
}

// Set for the fixers' commands, so a fix script calling `check --fix` again fails instead of recursing.
const RUNNING = 'KAYNOOO_CLI_FIX'
const JUSTFILES = ['justfile', 'Justfile', '.justfile']
const RUFF_CONFIGS = ['ruff.toml', '.ruff.toml']
const RUFF_SECTION = /^\[tool\.ruff/m
const MAX_CHANGED = 30
const JS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'])
const PY_EXTS = new Set(['.py', '.pyi'])
const PHP_EXTS = new Set(['.php'])
const GO_EXTS = new Set(['.go'])
const RS_EXTS = new Set(['.rs'])
const JS_FIXER = /^(?:(?:bunx|npx|pnpm\s+exec|yarn)\s+)?(?:keslint|eslint|oxlint|prettier|biome)\b/
const TRAILING_DOT = /\s+\.\/?$/

const quotePath = (path: string) => `'${path.replaceAll('\'', '\'\\\'\'')}'`

async function narrowFixers(found: Fixer[], cwd: string, base: string | undefined): Promise<Fixer[]> {
  const paths = await changedPaths(cwd, base)

  if (paths === undefined)
    fail('--changed needs a git repository')

  const result: Fixer[] = []
  const pkgText = await read(cwd, 'package.json')
  const scripts = pkgText === undefined ? {} : (JSON.parse(pkgText) as { scripts?: Record<string, string> }).scripts ?? {}

  for (const fixer of found) {
    if (fixer.name === 'python') {
      const files = paths.filter(path => PY_EXTS.has(extname(path)))

      if (files.length > 0)
        result.push({ ...fixer, command: `ruff check --fix ${files.map(quotePath).join(' ')} && ruff format ${files.map(quotePath).join(' ')}` })

      continue
    }

    if (fixer.name === 'php-cs-fixer') {
      const files = paths.filter(path => PHP_EXTS.has(extname(path)))

      if (files.length > 0)
        result.push({ ...fixer, command: `vendor/bin/php-cs-fixer fix ${files.map(quotePath).join(' ')}` })

      continue
    }

    if (fixer.name === 'go') {
      if (paths.some(path => GO_EXTS.has(extname(path)) || path === 'go.mod'))
        result.push(fixer)

      continue
    }

    if (fixer.name === 'rust') {
      if (paths.some(path => RS_EXTS.has(extname(path)) || path === 'Cargo.toml'))
        result.push(fixer)

      continue
    }

    if (fixer.name === 'makefile' || fixer.name === 'justfile') {
      if (paths.includes(fixer.source))
        result.push(fixer)

      continue
    }

    if (fixer.source === 'package.json') {
      const script = scripts[fixer.name]?.trim() ?? ''
      const files = paths.filter(path => JS_EXTS.has(extname(path)))

      if (JS_FIXER.test(script)) {
        if (files.length > 0) {
          const stripped = script.replace(TRAILING_DOT, '')

          result.push({ ...fixer, command: TRAILING_DOT.test(script) ? `${stripped} ${files.map(quotePath).join(' ')}` : `${fixer.command} -- ${files.map(quotePath).join(' ')}` })
        }

        continue
      }
    }

    result.push(fixer)
  }

  return result
}

// Writes beside the file and renames over it, so an interrupted write never leaves it half done.
async function replaceFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`

  await writeFile(temporary, content, { mode: statSync(path).mode & 0o777 })
  await rename(temporary, path)
}

const LINT_FIXERS = ['lint:fix', 'lint-fix', 'fix:lint', 'fix-lint', 'eslint:fix', 'eslint-fix', 'biome:fix', 'oxlint:fix']
const FORMAT_FIXERS = ['fmt', 'format', 'format:fix', 'format-fix', 'fmt:fix', 'fmt-fix', 'fix:format', 'fix:fmt', 'prettier', 'biome']
// A script command that rewrites files: the same tools as JS_FIXER, with the flag that makes them write.
const WRITING_FIXER = /^(?:(?:bunx|npx|pnpm\s+exec|yarn)\s+)?(?:(?:keslint|eslint|oxlint)\b.*\s--fix\b|prettier\b.*\s--write\b|biome\s+(?:check|format|lint)\b.*\s--(?:write|apply)\b)/

// The project's own fix script, recipe or target when it has one, else its lint fix and format ones by their usual names, else the package.json scripts whose command rewrites files.
async function projectFixers(dir: string): Promise<Fixer[]> {
  const found = await candidates(dir, 'check')
  const named = (names: string[]) => names.map(name => found.find(step => step.name === name)).find(step => step !== undefined)
  const all = named(['fix'])

  if (all !== undefined)
    return [all]

  const byName = [named(LINT_FIXERS), named(FORMAT_FIXERS)].filter(step => step !== undefined)

  if (byName.length > 0)
    return byName

  const text = await read(dir, 'package.json')
  const scripts = text === undefined ? {} : (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {}

  return found.filter(step => step.source === 'package.json' && typeof scripts[step.name] === 'string' && WRITING_FIXER.test(scripts[step.name] as string))
}

async function toolFixers(dir: string): Promise<Fixer[]> {
  const fixers: Fixer[] = []
  const makefile = await firstFile(dir, MAKEFILES)
  const justfile = await firstFile(dir, JUSTFILES)
  const ruff = await firstFile(dir, RUFF_CONFIGS) !== undefined || RUFF_SECTION.test(await read(dir, 'pyproject.toml') ?? '')

  if (makefile !== undefined) {
    fixers.push({ name: 'makefile', command: 'declare every target .PHONY', source: makefile, write: async (cwd) => {
      const path = join(cwd, makefile)
      const current = await Bun.file(path).text()
      const { content, targets } = declarePhony(current, name => existsSync(join(cwd, name)))

      if (content !== current)
        await replaceFile(path, content)

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
  const project = await projectFixers(dir)
  const csFixer = await firstFile(dir, CS_FIXER_CONFIGS)
  const php: Fixer[] = csFixer === undefined || project.some(fixer => fixer.source === 'composer.json') ? [] : [{ name: 'php-cs-fixer', command: 'vendor/bin/php-cs-fixer fix', source: csFixer }]

  return [...project, ...php, ...await toolFixers(dir)]
}

// Only the project's scripts and php-cs-fixer go into a compose service: the formatters and the file writer are the host's.
function runsInService(fixer: Fixer): boolean {
  return fixer.write === undefined && fixer.requires === undefined
}

async function runFixer(fixer: Fixer, placement: Placement | undefined, cwd: string, logFile: string, settings: Omit<StepSettings, 'env'>): Promise<Outcome> {
  if (fixer.write === undefined && placement !== undefined)
    return runStep(shellIn(placement, fixer.command, { [RUNNING]: '1' }), cwd, logFile, { ...settings, env: { [RUNNING]: '1' } })

  if (fixer.write === undefined)
    return runStep(fixer.command, cwd, logFile, { ...settings, env: { [RUNNING]: '1' } })

  const started = Date.now()
  let outcome: Outcome

  try {
    outcome = { ok: true, ms: 0, output: await fixer.write(cwd) }
  }
  catch (error) {
    outcome = { ok: false, ms: 0, output: error instanceof Error ? error.message : String(error) }
  }

  await writeFile(logFile, outcome.output, { mode: 0o600, flag: 'wx' })

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

// Runs the folder's fixers in order, one line each with what failed under a failing one, then lists the files they changed; returns 0 only when every fixer ran or was skipped for a missing binary.
export async function runFixers(values: FixValues, cwd: string): Promise<number> {
  const parsed = { values }
  const settings = placeSettings(values)

  if (process.env[RUNNING] !== undefined)
    fail('a fixer called check --fix again, which would recurse: give its script another command')

  const found = await fixers(cwd)

  if (found.length === 0)
    fail('nothing to fix here: no fix, lint:fix, fmt or format script (nor one running prettier --write, biome --write or eslint --fix), php-cs-fixer config, Makefile, Justfile, go.mod, Cargo.toml nor ruff config')

  const pickedAll = pick(found, parsed.values.only, 'fixer')
  const picked = parsed.values.changed === true ? await narrowFixers(pickedAll, cwd, parsed.values.base) : pickedAll

  if (picked.length === 0) {
    if (parsed.values.json === true)
      printJson(parsed.values.list === true ? [] : { fixers: [], changed: [] })
    else
      console.log('nothing changed to fix')

    return 0
  }

  const placements = new Map<Fixer, Placement | undefined>()

  for (const fixer of picked)
    placements.set(fixer, runsInService(fixer) ? await place(cwd, programOf(fixer.command), settings) : undefined)

  const json = parsed.values.json === true
  const missing = (fixer: Fixer) => fixer.requires !== undefined && Bun.which(fixer.requires) === null

  if (parsed.values.list === true) {
    if (json)
      printJson(picked.map(fixer => ({ name: fixer.name, command: fixer.command, source: fixer.source, ...(placements.get(fixer) === undefined ? {} : { in: placements.get(fixer)?.service }), ...(missing(fixer) ? { needs: fixer.requires } : {}) })))
    else
      console.log(table(picked.map(fixer => [fixer.name, fixer.command, missing(fixer) ? `${fixer.source}, needs ${fixer.requires}` : fixer.source, placements.get(fixer)?.service ?? 'host'])))

    return 0
  }

  const timeoutMs = parsed.values.timeout === undefined ? undefined : duration(parsed.values.timeout, 'timeout', 0)
  const directory = await logDirectory(cwd)
  const held = holdSignals()
  const runSettings: Omit<StepSettings, 'env'> = { ...(timeoutMs === undefined ? {} : { timeoutMs }), held }
  const stack = new Stack()

  const width = Math.max(...picked.map(fixer => fixer.name.length))
  const before = await dirtyFiles(cwd)
  const ran: (ReturnType<typeof outcomeJson> | { name: string, command: string, skipped: string })[] = []
  let failed = 0
  let timedOut = false

  try {
    for (const fixer of picked) {
      if (held.signal !== undefined)
        break

      if (missing(fixer)) {
        if (!json)
          console.log(`${paint(process.stdout).yellow('skip ')} ${fixer.name.padEnd(width)}  ${fixer.requires} is not installed`)

        ran.push({ name: fixer.name, command: fixer.command, skipped: `${fixer.requires} is not installed` })

        continue
      }

      const logFile = join(directory, `fix-${fixer.name.replaceAll(':', '-')}.log`)
      const placement = placements.get(fixer)
      const down = placement === undefined ? undefined : await stack.problem(placement)
      const outcome = down === undefined ? await runFixer(fixer, placement, cwd, logFile, runSettings) : await refusedStep(down, logFile)

      if (!json)
        printOutcome(fixer.name, width, placement === undefined ? fixer.command : `${fixer.command} (in ${placement.service})`, logFile, outcome)

      ran.push(outcomeJson(fixer.name, fixer.command, logFile, outcome, placement?.service))

      if (outcome.timedOut === true)
        timedOut = true

      if (!outcome.ok)
        failed++
    }
  }
  finally {
    held.release()
  }

  const after = before && await dirtyFiles(cwd)

  const changed = before !== undefined && after !== undefined ? changedFiles(before, after) : null

  if (json)
    printJson({ fixers: ran, changed })
  else if (changed !== null)
    printChanged(changed)

  if (held.signal !== undefined)
    return exitCodeOf(null, held.signal)

  if (timedOut)
    return 2

  return failed === 0 ? 0 : 1
}
