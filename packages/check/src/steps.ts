import { join } from 'node:path'
import { runCommand } from '@kaynooo/cli-kit'

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

// The order make itself reads them in.
export const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile']
const JUST_TIMEOUT_MS = 10_000

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
    throw new Error(`${file} is not valid JSON`)
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

  return steps
}

// The repo's steps: each of STEP_NAMES once, from package.json, else composer.json, else a Justfile, else a Makefile.
export async function discover(dir: string): Promise<Step[]> {
  const found = await candidates(dir, 'check')

  return STEP_NAMES.flatMap((name) => {
    const step = found.find(candidate => candidate.name === name)

    return step === undefined ? [] : [step]
  })
}
