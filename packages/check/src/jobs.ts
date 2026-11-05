// Everything `j` can run, read from the files declaring it: a justfile, a makefile, the scripts of a package.json, a composer.json and a deno.json, a Taskfile, mise tasks and a pyproject.
// Each reader takes the folder to read and whether it is the one `j` runs from: that one also looks up the parents for a manifest, the way the runners themselves do, while a child folder only counts the files it holds.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { SKIPPED_FOLDERS, warn } from '@kaynooo/cli-kit'
import { MAKEFILES } from './steps'

export interface Parameter {
  name: string
  default: unknown
  kind: 'singular' | 'plus' | 'star'
}

export type Kind = 'just' | 'make' | 'package' | 'composer' | 'deno' | 'task' | 'mise' | 'poe' | 'uv'

export interface Entry {
  kind: Kind
  // The runner's own name, which qualifies the entry on the command line and labels its line in the picker.
  tag: string
  runner: string[]
  // For the runners that take the flags after the name for their own, so the arguments go after a `--`.
  separated: boolean
  // Where it runs from, relative to the folder `j` runs from, `.` for that one.
  dir: string
  name: string
  doc: string | null
  parameters: Parameter[]
  // What the preview shows, left out for just, whose `--show` prints it better.
  body?: string
}

type Manager = 'bun' | 'pnpm' | 'yarn' | 'npm'
type Item = Pick<Entry, 'name'> & Partial<Pick<Entry, 'doc' | 'body' | 'parameters'>>

interface Recipe {
  namepath: string
  doc: string | null
  private: boolean
  parameters: Parameter[]
}

interface Dump {
  recipes: Record<string, Recipe>
  modules: Record<string, Dump>
}

interface MiseTask {
  name: string
  description: string
  source: string
  hide: boolean
  global: boolean
  run: string[]
  file: string | null
}

type Table = Record<string, unknown>
type Reader = (dir: string, here: boolean) => Entry[]

const JUSTFILE = /^\.?justfile$/i
const TASKFILES = ['Taskfile.yml', 'taskfile.yml', 'Taskfile.yaml', 'taskfile.yaml', 'Taskfile.dist.yml', 'taskfile.dist.yml', 'Taskfile.dist.yaml', 'taskfile.dist.yaml']
const MISE_FILES = ['mise.toml', '.mise.toml', 'mise.local.toml', '.mise.local.toml', 'mise', '.mise', 'mise-tasks', '.mise-tasks', '.config/mise.toml', '.config/mise']
// Yarn 1 and yarn 2+ share `yarn.lock`, and `yarn run` alike.
const LOCKFILES: [string, Manager][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]
// Folders holding what was built or installed, never a project of their own.
const QUALIFIED = /^([a-z]+):(?!:)(.+)$/
const BLANKS = /\s+/
const TRAILING_SLASHES = /\/+$/
const VERSION_SUFFIX = /@.*/
const LEADING_HASHES = /^#*/

const installed = new Map<string, boolean>()

function has(tool: string): boolean {
  if (!installed.has(tool))
    installed.set(tool, Bun.which(tool) !== null)

  return installed.get(tool)!
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir)
  }
  catch {
    return []
  }
}

// The first of `names` in `dir`, and for the folder `j` runs from, in the nearest parent holding one, no higher than the repository root.
export function locate(dir: string, here: boolean, names: string[]): string | undefined {
  for (let current = dir; ; current = join(current, '..')) {
    const found = names.find(name => existsSync(join(current, name)))

    if (found !== undefined)
      return join(current, found)

    const absolute = resolvePath(current)

    if (!here || existsSync(join(current, '.git')) || dirname(absolute) === absolute)
      return undefined
  }
}

// The direct children, hidden and built ones aside.
export function children(dir = '.'): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(child => child.isDirectory() && !child.name.startsWith('.') && !SKIPPED_FOLDERS.has(child.name))
    .map(child => child.name)
    .toSorted()
}

function build(base: Pick<Entry, 'kind' | 'tag' | 'runner' | 'separated' | 'dir'>, items: Item[]): Entry[] {
  return items.map(item => ({ ...base, doc: null, parameters: [], ...item }))
}

// A script is a command, a list of them, or a table holding one, whose other keys the preview shows as they are.
function text(value: unknown): string {
  if (typeof value === 'string')
    return value

  if (Array.isArray(value) && value.every(line => typeof line === 'string'))
    return value.join('\n')

  return Bun.YAML.stringify(value, null, 2) ?? ''
}

function field(value: unknown, key: string): string | null {
  const found = value !== null && typeof value === 'object' ? (value as Table)[key] : undefined

  return typeof found === 'string' ? found : null
}

// Module recipes are addressed as `module::recipe`, which is exactly the namepath just gives them.
function recipes(tree: Dump): Recipe[] {
  return [...Object.values(tree.recipes).filter(recipe => !recipe.private), ...Object.values(tree.modules).flatMap(module => recipes(module))]
}

// The justfile of a child folder is named, since just would otherwise look up the parents and find the one here.
export function justFlags(dir: string, here: boolean): string[] | undefined {
  if (here)
    return []

  const file = list(dir).find(name => JUSTFILE.test(name))

  return file === undefined ? undefined : ['--justfile', join(dir, file)]
}

function just(dir: string, here: boolean): Entry[] {
  const flags = justFlags(dir, here)

  if (flags === undefined || !has('just'))
    return []

  const proc = Bun.spawnSync(['just', ...flags, '--dump', '--dump-format', 'json'], { stderr: 'pipe' })

  if (!proc.success)
    return []

  const items = recipes(JSON.parse(proc.stdout.toString()) as Dump).map(recipe => ({ name: recipe.namepath, doc: recipe.doc, parameters: recipe.parameters }))

  return build({ kind: 'just', tag: 'just', runner: ['just'], separated: false, dir }, items)
}

// Targets of the makefile, read from its text rather than from `make --print-data-base`: the database drops the `##` comments a target is documented with, and gives no body to preview.
// A target is documented either by a trailing `## doc` or by a `## doc` line right above it, the two conventions found in the wild.
export function targets(source: string): { name: string, doc: string | null }[] {
  const found = new Map<string, string | null>()
  let pending: string | null = null

  for (const line of source.split('\n')) {
    // Recipe bodies, which only the preview cares about.
    if (line.startsWith('\t'))
      continue

    const [rule = '', ...rest] = line.split('#')
    const comment = rest.join('#').replace(LEADING_HASHES, '').trim() || null

    if (rule.trim() === '') {
      pending = line.startsWith('##') ? comment : null

      continue
    }

    const colon = rule.indexOf(':')
    const assignment = rule[colon + 1] === '=' || rule.slice(colon + 1).startsWith(':=') || rule.slice(0, colon).includes('=')

    // Anything but a rule: a variable, a conditional, a directive.
    if (colon === -1 || assignment) {
      pending = null

      continue
    }

    const doc = comment ?? pending

    for (const name of rule.slice(0, colon).trim().split(BLANKS)) {
      // Special targets (`.PHONY`), pattern rules and anything still holding a variable are not things to run.
      if (name.startsWith('.') || name.includes('%') || name.includes('$'))
        continue

      // First definition wins, the way make itself takes the first recipe it sees.
      if (!found.has(name))
        found.set(name, doc)
    }

    pending = null
  }

  return [...found].map(([name, doc]) => ({ name, doc }))
}

// The rule and its body, make having no `just --show` of its own.
export function show(source: string, target: string): string {
  const lines = source.split('\n')
  // The same reading as `targets`, so a rule declaring several targets at once is found by any of them.
  const start = lines.findIndex((line) => {
    const hash = line.indexOf('#')
    const rule = hash === -1 ? line : line.slice(0, hash)
    const colon = rule.indexOf(':')

    return colon !== -1 && rule[colon + 1] !== '=' && !rule.slice(0, colon).includes('=') && rule.slice(0, colon).trim().split(BLANKS).includes(target)
  })

  if (start === -1)
    return target

  let end = start + 1

  while (end < lines.length && (lines[end]!.startsWith('\t') || lines[end]!.trim() === ''))
    end++

  return lines.slice(start, end).join('\n').trimEnd()
}

// Make reads the makefile of its own folder only, so no parent is looked up.
function make(dir: string): Entry[] {
  const file = MAKEFILES.find(name => existsSync(join(dir, name)))

  if (file === undefined)
    return []

  const source = readFileSync(join(dir, file), 'utf-8')

  return build({ kind: 'make', tag: 'make', runner: ['make'], separated: false, dir }, targets(source).map(target => ({ ...target, body: show(source, target.name) })))
}

// The `packageManager` field corepack goes by, then the nearest lockfile, looked for up the parents since a workspace package keeps it at the root.
// Bun when neither says.
export function manager(dir: string, manifest: Table): Manager {
  const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager.replace(VERSION_SUFFIX, '') : undefined
  const known = LOCKFILES.find(([, name]) => name === declared)

  if (known !== undefined)
    return known[1]

  for (let current = resolvePath(dir); ; current = dirname(current)) {
    const found = LOCKFILES.find(([file]) => existsSync(join(current, file)))

    if (found !== undefined)
      return found[1]

    if (dirname(current) === current)
      return 'bun'
  }
}

function table(value: unknown): Table {
  return value !== null && typeof value === 'object' ? value as Table : {}
}

// npm takes the flags after the script for its own, the other managers pass them on.
function packageScripts(dir: string, here: boolean): Entry[] {
  const file = locate(dir, here, ['package.json'])

  if (file === undefined)
    return []

  const manifest = JSON.parse(readFileSync(file, 'utf-8')) as Table
  const tool = manager(dirname(file), manifest)
  const items = Object.entries(table(manifest.scripts)).map(([name, command]) => ({ name, body: text(command) }))

  return build({ kind: 'package', tag: tool, runner: [tool, 'run'], separated: tool === 'npm', dir: dirname(file) }, items)
}

// Composer reads the options after the script as its own, and documents a script in `scripts-descriptions`.
function composer(dir: string, here: boolean): Entry[] {
  const file = locate(dir, here, ['composer.json'])

  if (file === undefined)
    return []

  const manifest = JSON.parse(readFileSync(file, 'utf-8')) as Table
  const descriptions = table(manifest['scripts-descriptions'])
  const items = Object.entries(table(manifest.scripts)).map(([name, command]) => ({ name, doc: field(descriptions, name), body: text(command) }))

  return build({ kind: 'composer', tag: 'composer', runner: ['composer', 'run'], separated: true, dir: dirname(file) }, items)
}

// A deno task is a command, or a table holding one with its description.
function deno(dir: string, here: boolean): Entry[] {
  const file = locate(dir, here, ['deno.json', 'deno.jsonc'])

  if (file === undefined)
    return []

  const manifest = Bun.JSONC.parse(readFileSync(file, 'utf-8')) as Table
  const items = Object.entries(table(manifest.tasks)).map(([name, task]) => ({ name, doc: field(task, 'description'), body: field(task, 'command') ?? text(task) }))

  return build({ kind: 'deno', tag: 'deno', runner: ['deno', 'task'], separated: false, dir: dirname(file) }, items)
}

// The tasks of the Taskfile itself, read from its YAML since `task` may not be installed to list them; the ones its `includes` bring in are left out.
// Task hands the arguments after a `--` to the task as `CLI_ARGS`.
function taskfile(dir: string, here: boolean): Entry[] {
  const file = locate(dir, here, TASKFILES)

  if (file === undefined)
    return []

  const tasks = table((Bun.YAML.parse(readFileSync(file, 'utf-8')) as Table | null)?.tasks)
  const items = Object.entries(tasks)
    .filter(([, task]) => !(task !== null && typeof task === 'object' && (task as Table).internal === true))
    .map(([name, task]) => ({ name, doc: field(task, 'desc') ?? field(task, 'summary'), body: text(task) }))

  return build({ kind: 'task', tag: 'task', runner: ['task'], separated: true, dir: dirname(file) }, items)
}

// Mise merges the tasks of every config up the parents and the global one, which is what the folder `j` runs from gets.
// A child folder keeps only the tasks it defines, the rest already being listed here.
function mise(dir: string, here: boolean): Entry[] {
  if (!has('mise') || (!here && !MISE_FILES.some(name => existsSync(join(dir, name)))))
    return []

  const proc = Bun.spawnSync(['mise', 'tasks', 'ls', '--json'], { cwd: dir, stderr: 'pipe' })

  if (!proc.success)
    return []

  const root = `${resolvePath(dir)}/`
  const items = (JSON.parse(proc.stdout.toString()) as MiseTask[])
    .filter(task => !task.hide && (here || (!task.global && task.source.startsWith(root))))
    .map(task => ({ name: task.name, doc: task.description || null, body: task.file ?? task.run.join('\n') }))

  return build({ kind: 'mise', tag: 'mise', runner: ['mise', 'run'], separated: false, dir }, items)
}

// Poe tasks, run through uv when the project has a `uv.lock`, a leading `_` marking the private ones; and the entry points of `[project.scripts]`, which only exist inside the project's environment.
function pyproject(dir: string, here: boolean): Entry[] {
  const file = locate(dir, here, ['pyproject.toml'])

  if (file === undefined)
    return []

  const manifest = Bun.TOML.parse(readFileSync(file, 'utf-8')) as Table
  const tool = table(manifest.tool)
  const project = table(manifest.project)
  const uv = locate(dirname(file), true, ['uv.lock']) !== undefined
  const poe = Object.entries(table(table(tool.poe).tasks))
    .filter(([name]) => !name.startsWith('_'))
    .map(([name, task]) => ({ name, doc: field(task, 'help'), body: field(task, 'cmd') ?? field(task, 'shell') ?? text(task) }))
  const entryPoints = Object.entries(table(project.scripts)).map(([name, target]) => ({ name, body: text(target) }))

  return [
    ...build({ kind: 'poe', tag: 'poe', runner: uv ? ['uv', 'run', 'poe'] : ['poe'], separated: false, dir: dirname(file) }, poe),
    ...build({ kind: 'uv', tag: 'uv', runner: ['uv', 'run'], separated: false, dir: dirname(file) }, entryPoints),
  ]
}

// In the order a name several of them share offers them.
const READERS = [just, make, packageScripts, composer, deno, taskfile, mise, pyproject]

const READER_OF: Record<Kind, Reader> = {
  just,
  make,
  package: packageScripts,
  composer,
  deno,
  task: taskfile,
  mise,
  poe: pyproject,
  uv: pyproject,
}

// The file each reader parses, named when it is skipped.
const MANIFEST_OF = new Map<Reader, string>([[just, 'justfile'], [make, 'Makefile'], [packageScripts, 'package.json'], [composer, 'composer.json'], [deno, 'deno.json'], [taskfile, 'Taskfile.yml'], [mise, 'mise.toml'], [pyproject, 'pyproject.toml']])

// The value of a file read and parsed, the fallback when it is missing or malformed.
function readOr<T>(read: () => T, fallback: T): T {
  try {
    return read()
  }
  catch {
    return fallback
  }
}

// The package folders the workspace globs of a package.json or a pnpm-workspace.yaml name, which may sit deeper than the direct children.
function workspaces(): string[] {
  const manifest = readOr<Table>(() => JSON.parse(readFileSync('package.json', 'utf-8')) as Table, {})
  const declared = Array.isArray(manifest.workspaces) ? manifest.workspaces : table(manifest.workspaces).packages
  const pnpm = readOr(() => table(Bun.YAML.parse(readFileSync('pnpm-workspace.yaml', 'utf-8'))).packages, undefined)
  const patterns = [declared, pnpm].flatMap(value => (Array.isArray(value) ? value.filter((pattern): pattern is string => typeof pattern === 'string') : []))
  const excluded = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => new Bun.Glob(pattern.slice(1)))

  return patterns
    .filter(pattern => !pattern.startsWith('!'))
    .flatMap(pattern => [...new Bun.Glob(`${pattern.replace(TRAILING_SLASHES, '')}/package.json`).scanSync({ cwd: '.' })].map(file => dirname(file)))
    .filter(dir => !dir.split('/').includes('node_modules') && !excluded.some(glob => glob.match(dir)))
}

// The direct children, then the workspace packages deeper down.
export function folders(): string[] {
  return [...new Set([...children(), ...workspaces()])].filter(dir => dir !== '.')
}

// What the folder `j` runs from offers, its parents included, then each child folder.
// A manifest that does not parse drops its own entries, not the whole listing.
function guarded(reader: Reader, dir: string, here: boolean, isWarned = false): Entry[] {
  try {
    return reader(dir, here)
  }
  catch (error) {
    if (isWarned)
      warn(`j: skipped ${join(dir, MANIFEST_OF.get(reader) ?? 'a manifest')}, it does not parse (${error instanceof Error ? error.message : String(error)})`)

    return []
  }
}

export function everything(): Entry[] {
  const here = READERS.flatMap(reader => guarded(reader, '.', true, true))
  const below = folders().flatMap(dir => READERS.flatMap(reader => guarded(reader, dir, false, true)))
  const seen = new Set<string>()

  return [...here, ...below].filter((entry) => {
    const id = `${entry.kind}\t${entry.dir}\t${entry.name}`
    const fresh = !seen.has(id)

    seen.add(id)

    return fresh
  })
}

// The entries of one kind in one folder, which is all the preview of a line needs to read again.
export function readKind(kind: Kind, dir: string): Entry[] {
  return guarded(READER_OF[kind], dir, dir === '.').filter(entry => entry.kind === kind)
}

export function key(entry: Entry): string {
  return entry.dir === '.' ? entry.name : `${entry.dir}/${entry.name}`
}

export function id(entry: Entry): string {
  return `${entry.tag}:${key(entry)}`
}

// A key finds the entry of this folder before the same name in a child folder, which is only reached by name when this one has none.
export function resolve(entries: Entry[], named: string): Entry[] {
  const qualified = QUALIFIED.exec(named)
  const tagged = qualified && entries.some(entry => entry.tag === qualified[1]) ? qualified : undefined
  const pool = tagged ? entries.filter(entry => entry.tag === tagged[1]) : entries
  const rest = tagged ? tagged[2]! : named
  const exact = pool.filter(entry => key(entry) === rest)

  return exact.length > 0 ? exact : pool.filter(entry => entry.name === rest)
}

// The key alone when it finds only this entry, qualified by the runner otherwise.
export function shortest(entries: Entry[], entry: Entry): string {
  const found = resolve(entries, key(entry))

  return found.length === 1 && found[0] === entry ? key(entry) : id(entry)
}

// Required parameters read as `<name>`, the ones just can do without as `[name]`.
export function signature(entry: Entry): string {
  return entry.parameters
    .map(parameter => (parameter.default === null && parameter.kind === 'singular' ? `<${parameter.name}>` : `[${parameter.name}]`))
    .join(' ')
}
