import { join } from 'node:path'

export interface Step {
  name: string
  // Run through `sh -c`.
  command: string
  source: string
}

// Validation steps in the order they run.
export const STEP_NAMES = ['check', 'typecheck', 'lint', 'test'] as const

const TARGET = /^(check|typecheck|lint|test)[ \t]*:(?!=)/gm
// A script that calls this very bin would recurse.
const SELF = /^check(?:\s|$)/

async function read(dir: string, ...files: string[]): Promise<string | undefined> {
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

// Every step name each source offers, in source order.
async function candidates(dir: string): Promise<Step[]> {
  const steps: Step[] = []
  const packageJson = await read(dir, 'package.json')
  const composerJson = await read(dir, 'composer.json')
  const justfile = await read(dir, 'Justfile', 'justfile', '.justfile')
  const makefile = await read(dir, 'Makefile', 'makefile')

  // Scripts go through `bun run`, as a `check` script of `$npm_execpath check` is Bun's type checker, not this bin.
  if (packageJson !== undefined) {
    for (const [name, value] of Object.entries(scripts('package.json', packageJson))) {
      if (!(typeof value === 'string' && SELF.test(value)))
        steps.push({ name, command: `bun run ${name}`, source: 'package.json' })
    }
  }

  if (composerJson !== undefined) {
    for (const name of Object.keys(scripts('composer.json', composerJson)))
      steps.push({ name, command: `composer run ${name}`, source: 'composer.json' })
  }

  for (const name of targets(justfile ?? ''))
    steps.push({ name, command: `just ${name}`, source: 'Justfile' })

  for (const name of targets(makefile ?? ''))
    steps.push({ name, command: `make ${name}`, source: 'Makefile' })

  return steps
}

// The repo's steps: each of STEP_NAMES once, from package.json, else composer.json, else a Justfile, else a Makefile.
export async function discover(dir: string): Promise<Step[]> {
  const found = await candidates(dir)

  return STEP_NAMES.flatMap((name) => {
    const step = found.find(candidate => candidate.name === name)

    return step === undefined ? [] : [step]
  })
}
