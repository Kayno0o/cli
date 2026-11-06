import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, ignoredFolders, runCommand } from '@kaynooo/cli-kit'

export interface Step {
  name: string
  // Run through `sh -c`.
  command: string
  source: string
}

// Validation steps in the order they run.
export const STEP_NAMES = ['check', 'typecheck', 'lint', 'test'] as const

// A recipe or target line, `@` and parameters included, which a variable set with := is not.
const TARGET = /^@?([\w-]+)(?:[ \t][^:=\n]*)?:(?!=)/gm
const JUSTFILES = ['justfile', 'Justfile', '.justfile']
const TASK_RUNNERS = new Set(['Justfile', 'Makefile'])

// The order make itself reads them in.
export const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile']
export const CS_FIXER_CONFIGS = ['.php-cs-fixer.php', '.php-cs-fixer.dist.php']
const JUST_TIMEOUT_MS = 10_000
const PHPSTAN_CONFIGS = ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon']
const PHPUNIT_CONFIGS = ['phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml']

interface JustDump {
  recipes?: Record<string, { private?: boolean, parameters?: { default: unknown, kind: string }[] }>
}

// The first of the files that exists in the folder, with its text.
export async function readFirst(dir: string, files: string[]): Promise<{ file: string, text: string } | undefined> {
  for (const file of files) {
    const handle = Bun.file(join(dir, file))

    if (await handle.exists())
      return { file, text: await handle.text() }
  }

  return undefined
}

export async function read(dir: string, ...files: string[]): Promise<string | undefined> {
  for (const file of files) {
    const handle = Bun.file(join(dir, file))

    if (await handle.exists())
      return handle.text()
  }

  return undefined
}

function scripts(file: string, text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> }

    return parsed.scripts ?? {}
  }
  catch {
    fail(`${file} is not valid JSON`)
  }
}

function targets(text: string): string[] {
  return [...text.matchAll(TARGET)].map(match => match[1] ?? '')
}

// The recipes just can run without an argument, from its own JSON dump; the lines of the file when just is missing or cannot read it.
async function recipes(dir: string, file: string, text: string): Promise<string[]> {
  if (Bun.which('just') === null)
    return targets(text)

  try {
    const ran = await runCommand(['just', '--justfile', file, '--dump', '--dump-format', 'json'], { cwd: dir, timeoutMs: JUST_TIMEOUT_MS })
    const dump = JSON.parse(ran.text) as JustDump

    if (ran.code !== 0)
      return targets(text)

    return Object.entries(dump.recipes ?? {})
      .filter(([, recipe]) => recipe.private !== true && (recipe.parameters ?? []).every(parameter => parameter.default !== null || parameter.kind === 'star'))
      .map(([name]) => name)
  }
  catch {
    return targets(text)
  }
}

// A script that calls the bin running it would recurse.
function callsSelf(value: unknown, bin: string): boolean {
  return typeof value === 'string' && (value === bin || value.startsWith(`${bin} `) || value.startsWith(`${bin}\t`))
}

// Every script, recipe and target each source offers, in source order, but a package.json script calling `bin`.
export async function candidates(dir: string, bin: string): Promise<Step[]> {
  const steps: Step[] = []
  const packageJson = await read(dir, 'package.json')
  const composerJson = await read(dir, 'composer.json')
  const justfile = await readFirst(dir, JUSTFILES)
  const makefile = await read(dir, ...MAKEFILES)

  // Scripts go through `bun run`, as a `check` script of `$npm_execpath check` is Bun's type checker, not this bin.
  if (packageJson !== undefined) {
    for (const [name, value] of Object.entries(scripts('package.json', packageJson))) {
      if (!callsSelf(value, bin))
        steps.push({ name, command: `bun run ${name}`, source: 'package.json' })
    }
  }

  if (composerJson !== undefined) {
    for (const name of Object.keys(scripts('composer.json', composerJson)))
      steps.push({ name, command: `composer run ${name}`, source: 'composer.json' })
  }

  if (justfile !== undefined) {
    for (const name of await recipes(dir, justfile.file, justfile.text))
      steps.push({ name, command: `just ${name}`, source: 'Justfile' })
  }

  for (const name of targets(makefile ?? ''))
    steps.push({ name, command: `make ${name}`, source: 'Makefile' })

  steps.push(...await phpSteps(dir))

  return steps
}

// The first of the files that exists in the folder.
export async function firstFile(dir: string, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    if (await Bun.file(join(dir, name)).exists())
      return name
  }

  return undefined
}

// The PHP tools a folder configures, last in line so that a composer script of the same name wins.
async function phpSteps(dir: string): Promise<Step[]> {
  const steps: Step[] = []
  const phpstan = await firstFile(dir, PHPSTAN_CONFIGS)
  const csFixer = await firstFile(dir, CS_FIXER_CONFIGS)
  const phpunit = await firstFile(dir, PHPUNIT_CONFIGS)

  if (phpstan !== undefined)
    steps.push({ name: 'typecheck', command: 'vendor/bin/phpstan analyse --no-progress --memory-limit=1G', source: phpstan })

  if (csFixer !== undefined)
    steps.push({ name: 'lint', command: 'vendor/bin/php-cs-fixer fix --dry-run -v', source: csFixer })

  if (phpunit !== undefined)
    steps.push({ name: 'test', command: 'vendor/bin/phpunit', source: phpunit })

  return steps
}

export interface Project {
  // The subfolder's name, undefined for the folder itself.
  name?: string
  dir: string
  steps: Step[]
}

// The folder's own steps, else those of each subfolder that has some (api/ and client/ of a root without a manifest).
export async function discoverProjects(dir: string): Promise<Project[]> {
  const own = await discover(dir)

  if (own.length > 0)
    return [{ dir, steps: own }]

  const projects: Project[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  const ignored = ignoredFolders(['var', 'tmp'])

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || ignored.has(entry.name))
      continue

    const steps = await discover(join(dir, entry.name))

    if (steps.length > 0)
      projects.push({ name: entry.name, dir: join(dir, entry.name), steps })
  }

  return projects
}

// The repo's steps: each of STEP_NAMES once, from package.json, else composer.json, else a Justfile, else a Makefile.
// A Justfile or Makefile `check` comes first, as a task runner's check is the repo's whole validation and usually wraps the script of that name.
export async function discover(dir: string): Promise<Step[]> {
  const found = await candidates(dir, 'check')
  const runnerCheck = found.find(candidate => candidate.name === 'check' && TASK_RUNNERS.has(candidate.source))

  return STEP_NAMES.flatMap((name) => {
    const step = name === 'check' && runnerCheck !== undefined ? runnerCheck : found.find(candidate => candidate.name === name)

    return step === undefined ? [] : [step]
  })
}
