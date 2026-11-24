import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { $ } from 'bun'
import { read } from './steps'

export interface Narrowed {
  // The command to run, the step's own when it cannot be narrowed.
  command: string
  // Said on the step's line when it was narrowed or could not be.
  note: string
}

const WRAPPER_PREFIX = /^(?:(?:bunx|npx|pnpm\s+exec|yarn|uv\s+run)\s+)+/
const LINTERS = /^(?:keslint|eslint|oxlint|biome\s+check|biome\s+lint)\b/
const LINTABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'])
const PYTHON_EXT = new Set(['.py', '.pyi'])
const TEST_RUNNER = /^(?:bun test|\$npm_execpath test)\b/
const VITEST_RUNNER = /^vitest(?:\s+run)?\b/
const PYTEST_RUNNER = /^pytest\b/
const RUFF_CHECK = /^ruff\s+check\b/
const RUFF_FORMAT = /^ruff\s+format\b/
const GO_TEST = /^go\s+test\s+\.\.\.\/?$|^go\s+test\s+\.\/\.\.\./
const TRAILING_DOT = /\s+\.\/?$/
const TEST_FILE = /\.(?:test|spec)\.[jt]sx?$/
const PY_TEST_FILE = /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/
const IMPORT_SPEC = /(?:from|import)\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g
const WHITESPACE = /\s+/

// Every file the working tree changes against `base` (default HEAD), staged, unstaged and untracked, relative to dir; undefined outside a repository.
export async function changedPaths(dir: string, base = 'HEAD'): Promise<string[] | undefined> {
  const tracked = await $`git diff --name-only --relative -z ${base}`.cwd(dir).quiet().nothrow()
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

// Sibling Python tests (`tests/test_<name>.py`, `<dir>/test_<name>.py`, `<dir>/<name>_test.py`).
function siblingPyTests(path: string, exists: (path: string) => boolean): string[] {
  const extension = extname(path)
  const name = basename(path, extension)
  const dir = dirname(path)
  const folders = [dir, join(dir, 'tests'), join(dir, '..', 'tests'), 'tests']
  const found = new Set<string>()

  for (const folder of folders) {
    for (const candidate of [`test_${name}.py`, `${name}_test.py`].map(file => join(folder, file))) {
      if (exists(candidate))
        found.add(candidate)
    }
  }

  return [...found]
}

// 1-hop reverse-import test selection: finds project test files that directly import any changed source file.
function reverseImportTests(dir: string, changedSources: string[]): string[] {
  if (changedSources.length === 0)
    return []

  const targets = new Set(changedSources.map((file) => {
    const abs = resolve(dir, file)
    const ext = extname(abs)

    return ext === '' ? abs : abs.slice(0, -ext.length)
  }))
  const found = new Set<string>()
  const glob = new Bun.Glob('**/*.{test,spec}.{ts,tsx,js,jsx}')

  for (const testFile of glob.scanSync({ cwd: dir })) {
    if (testFile.split('/').includes('node_modules') || testFile.startsWith('.git/'))
      continue

    let text: string

    try {
      text = readFileSync(join(dir, testFile), 'utf8')
    }
    catch {
      continue
    }

    const testDir = dirname(resolve(dir, testFile))

    for (const match of text.matchAll(IMPORT_SPEC)) {
      const specifier = match[1] ?? match[2] ?? ''

      if (!specifier.startsWith('.'))
        continue

      const imported = resolve(testDir, specifier)
      const ext = extname(imported)
      const stem = ext === '' ? imported : imported.slice(0, -ext.length)

      if (targets.has(stem) || targets.has(join(stem, 'index'))) {
        found.add(testFile)

        break
      }
    }
  }

  return [...found]
}

// Whether a script is a bare invocation of a tool (optionally prefixed with bunx/npx/pnpm exec/uv run, and optionally ending in `.` or `./`).
function isBare(script: string, tool: RegExp, allowDot = false): boolean {
  const unwrapped = script.trim().replace(WRAPPER_PREFIX, '')

  if (!tool.test(unwrapped))
    return false

  const rest = unwrapped.replace(tool, '').trim()

  if (rest === '')
    return true

  return rest.split(WHITESPACE).every(word => word === '' || word.startsWith('-') || (allowDot && (word === '.' || word === './')))
}

function stripTrailingDot(command: string): string {
  return command.replace(TRAILING_DOT, '')
}

function jsTestFiles(dir: string, changed: string[]): string[] {
  const tests = new Set<string>()
  const nonTests: string[] = []

  for (const path of changed) {
    if (TEST_FILE.test(path)) {
      tests.add(path)
    }
    else {
      if (LINTABLE.has(extname(path)))
        nonTests.push(path)

      for (const test of siblingTests(path, candidate => existsSync(join(dir, candidate))))
        tests.add(test)
    }
  }

  for (const imported of reverseImportTests(dir, nonTests))
    tests.add(imported)

  return [...tests]
}

// The command narrowed to the changed files when the step supports narrowing, else the step in full with a note saying so.
export async function narrow(step: { name: string, command: string, source: string }, dir: string, changed: string[]): Promise<Narrowed> {
  const script = step.source === 'package.json' ? (await scriptText(dir, step.name))?.trim() : undefined
  const effective = script ?? step.command.trim()
  const full = (why: string): Narrowed => ({ command: step.command, note: `in full, ${why}` })

  // JS/TS linters (package.json scripts, bare or wrapped with bunx/npx/pnpm exec, with or without trailing `.`).
  if (script !== undefined && step.name === 'lint' && isBare(script, LINTERS, true)) {
    const files = changed.filter(path => LINTABLE.has(extname(path)))

    if (files.length === 0)
      return { command: 'true', note: 'nothing changed to lint' }

    // If the underlying script ended with `.`, invoke the unwrapped command directly on the changed files so `.` isn't also linted.
    const endsWithDot = TRAILING_DOT.test(script)
    const narrowedCmd = endsWithDot ? `${stripTrailingDot(script)} ${files.map(quote).join(' ')}` : `${step.command} -- ${files.map(quote).join(' ')}`

    return { command: narrowedCmd, note: `${files.length} changed file${files.length === 1 ? '' : 's'}` }
  }

  // Ruff lint / format check (native or script).
  if ((step.name === 'lint' && isBare(effective, RUFF_CHECK, true)) || (step.name === 'fmt' && isBare(effective, RUFF_FORMAT, true))) {
    const files = changed.filter(path => PYTHON_EXT.has(extname(path)))

    if (files.length === 0)
      return { command: 'true', note: `nothing changed to ${step.name}` }

    const baseCmd = stripTrailingDot(effective)

    return { command: `${baseCmd} ${files.map(quote).join(' ')}`, note: `${files.length} changed file${files.length === 1 ? '' : 's'}` }
  }

  // Vitest supports `--related <files>` directly!
  if (step.name === 'test' && isBare(effective, VITEST_RUNNER)) {
    const files = changed.filter(path => LINTABLE.has(extname(path)))

    if (files.length === 0)
      return full('no JS/TS file changed')

    return { command: `${step.command} -- --related ${files.map(quote).join(' ')}`, note: `${files.length} related file${files.length === 1 ? '' : 's'}` }
  }

  // Bun test with sibling + 1-hop reverse-import test selection.
  if (script !== undefined && step.name === 'test' && isBare(script, TEST_RUNNER)) {
    const tests = jsTestFiles(dir, changed)

    if (tests.length === 0)
      return full('no test sits next to the changed files')

    return { command: `${step.command} -- ${tests.map(test => quote(`./${test}`)).join(' ')}`, note: `${tests.length} test file${tests.length === 1 ? '' : 's'}` }
  }

  // Pytest narrowing to changed or sibling Python test files.
  if (step.name === 'test' && isBare(effective, PYTEST_RUNNER, true)) {
    const tests = new Set<string>()

    for (const path of changed) {
      if (PY_TEST_FILE.test(path)) {
        tests.add(path)
      }
      else if (PYTHON_EXT.has(extname(path))) {
        for (const test of siblingPyTests(path, candidate => existsSync(join(dir, candidate))))
          tests.add(test)
      }
    }

    if (tests.size === 0)
      return full('no test sits next to the changed files')

    return { command: `${stripTrailingDot(effective)} ${[...tests].map(quote).join(' ')}`, note: `${tests.size} test file${tests.size === 1 ? '' : 's'}` }
  }

  // Go test narrowing from `go test ./...` to changed Go package directories.
  if (step.name === 'test' && GO_TEST.test(effective)) {
    const pkgs = [...new Set(changed.filter(path => extname(path) === '.go').map((path) => {
      const folder = dirname(path)

      return folder === '.' ? '.' : `./${folder}`
    }))]

    if (pkgs.length === 0)
      return { command: 'true', note: 'no Go files changed' }

    return { command: `go test ${pkgs.map(quote).join(' ')}`, note: `${pkgs.length} Go package${pkgs.length === 1 ? '' : 's'}` }
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
