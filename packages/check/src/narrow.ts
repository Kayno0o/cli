import { existsSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { $ } from 'bun'
import { read } from './steps'

export interface Narrowed {
  // The command to run, the step's own when it cannot be narrowed.
  command: string
  // Said on the step's line when it was narrowed or could not be.
  note: string
}

const LINTERS = /^(?:keslint|eslint|oxlint)\b/
const LINTABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'])
const TEST_RUNNER = /^(?:bun test|\$npm_execpath test)\b/
const TEST_FILE = /\.(?:test|spec)\.[jt]sx?$/
const WHITESPACE = /\s+/

// Every file the working tree changes against HEAD, staged, unstaged and untracked, relative to dir; undefined outside a repository.
export async function changedPaths(dir: string): Promise<string[] | undefined> {
  const tracked = await $`git diff --name-only --relative -z HEAD`.cwd(dir).quiet().nothrow()
  const untracked = await $`git ls-files -z --others --exclude-standard`.cwd(dir).quiet().nothrow()

  if (tracked.exitCode !== 0 || untracked.exitCode !== 0)
    return undefined

  return [...new Set([...tracked.stdout.toString().split('\0'), ...untracked.stdout.toString().split('\0')])].filter(path => path !== '' && existsSync(join(dir, path)))
}

// The tests that sit next to a source file or in its package's tests folder.
export function siblingTests(path: string, exists: (path: string) => boolean): string[] {
  const extension = extname(path)
  const name = basename(path, extension)
  const dir = dirname(path)
  const folders = [dir, join(dir, 'tests'), join(dir, '..', 'tests'), join(dir, '__tests__')]

  const found = new Set<string>()

  for (const folder of folders) {
    for (const kind of ['test', 'spec']) {
      for (const candidate of [`${name}.${kind}${extension}`, `${name}.${kind}.ts`].map(file => join(folder, file))) {
        if (exists(candidate))
          found.add(candidate)
      }
    }
  }

  return [...found]
}

// Whether a script is a bare invocation of a tool, so the files given after it are all it works on.
function isBare(script: string, tool: RegExp): boolean {
  return tool.test(script.trim()) && script.trim().replace(tool, '').split(WHITESPACE).every(word => word.startsWith('-') || word === '')
}

// The command narrowed to the changed files when the step is a bare linter or `bun test` script, else the step in full with a note saying so.
export async function narrow(step: { name: string, command: string, source: string }, dir: string, changed: string[]): Promise<Narrowed> {
  const script = step.source === 'package.json' ? (await scriptText(dir, step.name))?.trim() : undefined
  const full = (why: string): Narrowed => ({ command: step.command, note: `in full, ${why}` })

  if (script !== undefined && step.name === 'lint' && isBare(script, LINTERS)) {
    const files = changed.filter(path => LINTABLE.has(extname(path)))

    return files.length === 0 ? { command: 'true', note: 'nothing changed to lint' } : { command: `${step.command} -- ${files.map(quote).join(' ')}`, note: `${files.length} changed file${files.length === 1 ? '' : 's'}` }
  }

  if (script !== undefined && step.name === 'test' && isBare(script, TEST_RUNNER)) {
    const tests = new Set<string>()

    for (const path of changed) {
      if (TEST_FILE.test(path)) {
        tests.add(path)
      }
      else {
        for (const test of siblingTests(path, candidate => existsSync(join(dir, candidate)))) {
          tests.add(test)
        }
      }
    }

    if (tests.size === 0)
      return full('no test sits next to the changed files')

    return { command: `${step.command} -- ${[...tests].map(test => quote(`./${test}`)).join(' ')}`, note: `${tests.size} test file${tests.size === 1 ? '' : 's'}` }
  }

  return full(`${step.name} cannot be narrowed`)
}

function quote(path: string): string {
  return `'${path.replaceAll('\'', '\'\\\'\'')}'`
}

async function scriptText(dir: string, name: string): Promise<string | undefined> {
  const text = await read(dir, 'package.json')

  if (text === undefined)
    return undefined

  try {
    const value = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts?.[name]

    return typeof value === 'string' ? value : undefined
  }
  catch {
    return undefined
  }
}
// x
