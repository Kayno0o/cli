import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { fail, ignoredFolders, runCommand } from '@kaynooo/cli-kit'
import { folders, manager, workspaces } from './jobs'

export interface Step {
  name: string
  // Run through `sh -c`.
  command: string
  source: string
}

export interface CheckConfig {
  steps?: Record<string, string | null>
  only?: string[]
  parallel?: boolean
  failFast?: boolean
  timeout?: string
  lock?: string
  base?: string
}

// Validation steps in the order they run.
export const STEP_NAMES = ['check', 'typecheck', 'lint', 'fmt', 'test'] as const
// The scripts or recipes a step runs, in order of preference, when not the one bearing its name: `fmt` runs a format check, never the `fmt` script rewriting the files.
const STEP_SOURCES: Record<string, string[]> = { fmt: ['fmt:check', 'format:check', 'fmt-check', 'format-check'] }

// A recipe or target line, `@` and parameters included, which a variable set with := is not.
const TARGET = /^@?([\w-]+)(?:[ \t][^:=\n]*)?:(?!=)/gm
const JUSTFILES = ['justfile', 'Justfile', '.justfile']
const TASKFILES = ['Taskfile.yml', 'taskfile.yml', 'Taskfile.yaml', 'taskfile.yaml', 'Taskfile.dist.yml', 'taskfile.dist.yml', 'Taskfile.dist.yaml', 'taskfile.dist.yaml']
const DENO_FILES = ['deno.json', 'deno.jsonc']
const MISE_FILES = ['mise.toml', '.mise.toml', '.config/mise.toml']
const CHECKRC_FILES = ['.checkrc.jsonc', '.checkrc.json']
const TASK_RUNNERS = new Set(['Justfile', 'Makefile', 'Taskfile', 'mise'])

// The order make itself reads them in.
export const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile']
export const CS_FIXER_CONFIGS = ['.php-cs-fixer.php', '.php-cs-fixer.dist.php']
const JUST_TIMEOUT_MS = 10_000
const PHPSTAN_CONFIGS = ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon']
const PHPUNIT_CONFIGS = ['phpunit.xml', 'phpunit.xml.dist', 'phpunit.dist.xml']
const RUFF_CONFIGS = ['ruff.toml', '.ruff.toml']
const PYTEST_CONFIGS = ['pytest.ini', 'conftest.py']
const MYPY_CONFIGS = ['mypy.ini', '.mypy.ini']
const RUFF_SECTION = /^\[tool\.ruff/m
const PYTEST_SECTION = /^\[tool\.pytest/m
const MYPY_SECTION = /^\[tool\.mypy/m

interface JustDump {
  recipes?: Record<string, { private?: boolean, parameters?: { default: unknown, kind: string }[] }>
}

interface MiseTask {
  name: string
  hide: boolean
  global: boolean
  source: string
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

// Optional per-project overrides from .checkrc.json or .checkrc.jsonc.
export async function loadCheckConfig(dir: string): Promise<CheckConfig | undefined> {
  const found = await readFirst(dir, CHECKRC_FILES)

  if (found === undefined)
    return undefined

  try {
    const parsed: unknown = Bun.JSONC.parse(found.text)

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      fail(`${found.file} must be a JSON object`)

    return parsed
  }
  catch (error) {
    fail(`${found.file} is not valid JSONC: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parseJsonManifest(file: string, text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>

    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  }
  catch {
    fail(`${file} is not valid JSON`)
  }
}

function scriptsOf(manifest: Record<string, unknown>): Record<string, unknown> {
  const value = manifest.scripts

  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
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

async function miseTasks(dir: string): Promise<string[]> {
  if (Bun.which('mise') === null || !MISE_FILES.some(name => existsSync(join(dir, name))))
    return []

  try {
    const ran = await runCommand(['mise', 'tasks', 'ls', '--json'], { cwd: dir, timeoutMs: JUST_TIMEOUT_MS })

    if (ran.code !== 0)
      return []

    const root = `${resolve(dir)}/`

    return (JSON.parse(ran.text) as MiseTask[])
      .filter(task => !task.hide && !task.global && task.source.startsWith(root))
      .map(task => task.name)
  }
  catch {
    return []
  }
}

// A script that calls the bin running it would recurse.
function callsSelf(value: unknown, bin: string): boolean {
  return typeof value === 'string' && (value === bin || value.startsWith(`${bin} `) || value.startsWith(`${bin}\t`))
}

// Every script, recipe and target each source offers, in source order, but a package.json script calling `bin`.
export async function candidates(dir: string, bin: string, includeNative = false): Promise<Step[]> {
  const steps: Step[] = []
  const packageJson = await read(dir, 'package.json')
  const composerJson = await read(dir, 'composer.json')
  const denoFile = await readFirst(dir, DENO_FILES)
  const justfile = await readFirst(dir, JUSTFILES)
  const makefile = await read(dir, ...MAKEFILES)
  const taskfile = await readFirst(dir, TASKFILES)
  const pyprojectText = await read(dir, 'pyproject.toml')

  // Scripts go through the repo's detected package manager (lockfile or packageManager field, defaulting to bun).
  if (packageJson !== undefined) {
    const manifest = parseJsonManifest('package.json', packageJson)
    const tool = manager(dir, manifest)

    for (const [name, value] of Object.entries(scriptsOf(manifest))) {
      if (!callsSelf(value, bin))
        steps.push({ name, command: `${tool} run ${name}`, source: 'package.json' })
    }
  }

  if (composerJson !== undefined) {
    const manifest = parseJsonManifest('composer.json', composerJson)

    for (const name of Object.keys(scriptsOf(manifest)))
      steps.push({ name, command: `composer run ${name}`, source: 'composer.json' })
  }

  if (denoFile !== undefined) {
    try {
      const parsed = Bun.JSONC.parse(denoFile.text) as { tasks?: Record<string, unknown> } | null

      for (const name of Object.keys(parsed?.tasks ?? {}))
        steps.push({ name, command: `deno task ${name}`, source: denoFile.file })
    }
    catch {
      // Ignore malformed deno config here.
    }
  }

  if (justfile !== undefined) {
    for (const name of await recipes(dir, justfile.file, justfile.text))
      steps.push({ name, command: `just ${name}`, source: 'Justfile' })
  }

  for (const name of targets(makefile ?? ''))
    steps.push({ name, command: `make ${name}`, source: 'Makefile' })

  if (taskfile !== undefined) {
    try {
      const parsed = Bun.YAML.parse(taskfile.text) as { tasks?: Record<string, unknown> } | null

      for (const [name, task] of Object.entries(parsed?.tasks ?? {})) {
        if (!(task !== null && typeof task === 'object' && (task as Record<string, unknown>).internal === true))
          steps.push({ name, command: `task ${name}`, source: 'Taskfile' })
      }
    }
    catch {
      // Ignore malformed Taskfile here.
    }
  }

  for (const name of await miseTasks(dir))
    steps.push({ name, command: `mise run ${name}`, source: 'mise' })

  if (pyprojectText !== undefined) {
    try {
      const parsed = Bun.TOML.parse(pyprojectText) as { tool?: { poe?: { tasks?: Record<string, unknown> } } }
      const uv = existsSync(join(dir, 'uv.lock'))
      const runner = uv ? 'uv run poe' : 'poe'

      for (const name of Object.keys(parsed.tool?.poe?.tasks ?? {})) {
        if (!name.startsWith('_'))
          steps.push({ name, command: `${runner} ${name}`, source: 'pyproject.toml' })
      }
    }
    catch {
      // Ignore malformed pyproject.toml here.
    }
  }

  steps.push(...await phpSteps(dir))

  if (includeNative)
    steps.push(...await nativeSteps(dir, pyprojectText))

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

// Native Go, Rust, and Python validation steps when no explicit script/recipe defines them.
async function nativeSteps(dir: string, pyprojectText: string | undefined): Promise<Step[]> {
  const steps: Step[] = []

  if (existsSync(join(dir, 'go.mod'))) {
    steps.push({ name: 'lint', command: 'go vet ./...', source: 'go.mod' })
    steps.push({ name: 'test', command: 'go test ./...', source: 'go.mod' })
  }

  if (existsSync(join(dir, 'Cargo.toml'))) {
    steps.push({ name: 'check', command: 'cargo check', source: 'Cargo.toml' })
    steps.push({ name: 'lint', command: 'cargo clippy', source: 'Cargo.toml' })
    steps.push({ name: 'fmt:check', command: 'cargo fmt -- --check', source: 'Cargo.toml' })
    steps.push({ name: 'test', command: 'cargo test', source: 'Cargo.toml' })
  }

  const uv = existsSync(join(dir, 'uv.lock'))
  const pyPrefix = uv ? 'uv run ' : ''
  const ruffFile = await firstFile(dir, RUFF_CONFIGS)
  const hasRuff = ruffFile !== undefined || (pyprojectText !== undefined && RUFF_SECTION.test(pyprojectText))
  const hasMypy = await firstFile(dir, MYPY_CONFIGS) !== undefined || (pyprojectText !== undefined && MYPY_SECTION.test(pyprojectText))
  const hasPytest = await firstFile(dir, PYTEST_CONFIGS) !== undefined || (pyprojectText !== undefined && PYTEST_SECTION.test(pyprojectText))

  if (hasMypy)
    steps.push({ name: 'typecheck', command: `${pyPrefix}mypy .`, source: 'mypy' })

  if (hasRuff) {
    const source = ruffFile ?? 'pyproject.toml'

    steps.push({ name: 'lint', command: `${pyPrefix}ruff check .`, source })
    steps.push({ name: 'fmt:check', command: `${pyPrefix}ruff format --check .`, source })
  }

  if (hasPytest)
    steps.push({ name: 'test', command: `${pyPrefix}pytest`, source: 'pytest' })

  return steps
}

export interface Project {
  // The subfolder's or workspace's name, undefined for the folder itself.
  name?: string
  dir: string
  steps: Step[]
}

function packageNameOf(dir: string): string | undefined {
  const file = join(dir, 'package.json')

  if (!existsSync(file))
    return undefined

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }

    return typeof parsed.name === 'string' ? parsed.name : undefined
  }
  catch {
    return undefined
  }
}

// Resolves positional target arguments (paths, subfolder names, or workspace package names) to directories.
async function resolveTargets(dir: string, targets: string[]): Promise<Project[]> {
  const known = folders(dir)
  const projects: Project[] = []
  const seen = new Set<string>()

  for (const target of targets) {
    const direct = resolve(dir, target)
    let matchedDir: string | undefined

    if (existsSync(direct)) {
      matchedDir = direct
    }
    else {
      const hit = known.find(sub => sub === target || basename(sub) === target || packageNameOf(join(dir, sub)) === target)

      if (hit !== undefined)
        matchedDir = join(dir, hit)
    }

    if (matchedDir === undefined)
      fail(`no path or workspace matching ${target}`)

    if (seen.has(matchedDir))
      continue

    seen.add(matchedDir)

    const steps = await discover(matchedDir)

    if (steps.length === 0)
      fail(`no check steps found in ${target}`)

    const rel = relative(dir, matchedDir)

    projects.push({ ...(rel === '' ? {} : { name: rel }), dir: matchedDir, steps })
  }

  return projects
}

// The folder's own steps, else those of each subfolder/workspace that has some (api/ and client/ of a root without a manifest, or monorepo workspaces).
export async function discoverProjects(dir: string, targets?: string[]): Promise<Project[]> {
  if (targets !== undefined && targets.length > 0)
    return resolveTargets(dir, targets)

  const own = await discover(dir)

  if (own.length > 0)
    return [{ dir, steps: own }]

  const projects: Project[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  const ignored = ignoredFolders(['var', 'tmp'])
  const direct = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !ignored.has(entry.name))
    .map(entry => entry.name)
  const subdirs = [...new Set([...direct, ...workspaces(dir)])].filter(name => name !== '.').toSorted((a, b) => a.localeCompare(b))

  for (const sub of subdirs) {
    const steps = await discover(join(dir, sub))

    if (steps.length > 0)
      projects.push({ name: sub, dir: join(dir, sub), steps })
  }

  return projects
}

// The repo's steps: each of STEP_NAMES once, from package.json, composer.json, deno.json, Justfile, Makefile, Taskfile, mise, pyproject, or native tools; `fmt` runs a fmt:check or format:check script.
// A task runner's `check` comes first, as it usually wraps the repo's whole validation. `.checkrc.json` overrides or disables individual steps.
export async function discover(dir: string): Promise<Step[]> {
  const found = await candidates(dir, 'check', true)
  const config = await loadCheckConfig(dir)
  const overrides = config?.steps ?? {}
  const runnerCheck = found.find(candidate => candidate.name === 'check' && TASK_RUNNERS.has(candidate.source))

  const base: Step[] = STEP_NAMES.flatMap((name) => {
    if (name in overrides) {
      const custom = overrides[name]

      return custom === null || custom === undefined ? [] : [{ name, command: custom, source: '.checkrc.json' }]
    }

    const step = name === 'check' && runnerCheck !== undefined ? runnerCheck : (STEP_SOURCES[name] ?? [name]).map(each => found.find(candidate => candidate.name === each)).find(each => each !== undefined)

    return step === undefined ? [] : [{ ...step, name }]
  })

  // Any custom step names declared in .checkrc.json outside STEP_NAMES append at the end.
  for (const [name, command] of Object.entries(overrides)) {
    if (!STEP_NAMES.includes(name as typeof STEP_NAMES[number]) && typeof command === 'string' && command !== '')
      base.push({ name, command, source: '.checkrc.json' })
  }

  return base
}
