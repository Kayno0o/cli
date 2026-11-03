import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** How to reach one compose project: the command a user runs, and the one this package lists it with. */
export interface Stack {
  /** Relative to the folder it runs from, `.` for that one. */
  dir: string
  /** Typed as is, `docker compose` from the folder itself, `env -C <dir> docker compose ...` from another. */
  run: string[]
  list: { argv: string[], cwd: string, env: Record<string, string | undefined> }
  /** The compose project, for a stack found through its containers rather than a compose file compose finds on its own. */
  project?: string
}

/** What compose recorded on a container of the stack it brought up. */
export interface Labels {
  project: string
  files: string[]
  envFiles: string[]
  workdir: string
}

export interface Service {
  stack: Stack
  /** The compose project the stack resolves to. */
  project: string
  name: string
  state: string
  status: string
  ports: string
  image: string
}

export type Action = 'shell' | 'logs' | 'restart' | 'up' | 'stop' | 'build'

interface Config {
  name?: string
  services?: Record<string, { image?: string, ports?: { target?: number, published?: string }[] }>
}

export interface Container {
  Service: string
  State: string
  Status: string
  /** Empty for a container with no healthcheck. */
  Health?: string
  ExitCode?: number
}

const LABEL_FORMAT = ['project', 'project.config_files', 'project.environment_file', 'project.working_dir'].map(label => `{{.Label "com.docker.compose.${label}"}}`).join('\t')
const COMPOSE_FILE_VAR = /^\s*(?:export\s+)?COMPOSE_FILE\s*=\s*\S/m
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
const SKIPPED = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'venv', '__pycache__'])

export const ACTIONS: Action[] = ['shell', 'logs', 'restart', 'up', 'stop', 'build']

/** The command behind `env -C` when it runs from another folder than this one. */
export function from(dir: string, command: string[]): string[] {
  return dir === '.' ? command : ['env', '-C', dir, ...command]
}

/** The direct child folders, hidden and built ones aside. */
export function children(dir = '.'): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(child => child.isDirectory() && !child.name.startsWith('.') && !SKIPPED.has(child.name))
    .map(child => child.name)
    .sort()
}

/** The folder and its parents, relative to it, up to the repository root. */
export function up(dir: string): string[] {
  const dirs: string[] = []

  for (let current = dir; ; current = join(current, '..')) {
    dirs.push(current)

    const absolute = resolve(current)

    if (existsSync(join(current, '.git')) || dirname(absolute) === absolute)
      return dirs
  }
}

export function stackAt(dir: string): Stack {
  return { dir, run: from(dir, ['docker', 'compose']), list: { argv: ['docker', 'compose'], cwd: resolve(dir), env: process.env } }
}

/** A compose file compose finds on its own, or a .env naming the ones to use, which compose reads too. */
export function holdsStack(dir: string): boolean {
  if (COMPOSE_FILES.some(name => existsSync(join(dir, name))))
    return true

  try {
    return COMPOSE_FILE_VAR.test(readFileSync(join(dir, '.env'), 'utf-8'))
  }
  catch {
    return false
  }
}

/** The stack of `dir` or of its nearest parent, up to the repository root. */
export function nearestStack(dir: string): Stack | undefined {
  const found = up(dir).find(holdsStack)

  return found === undefined ? undefined : stackAt(found)
}

/** The stack of this folder or its nearest parent holding a compose file, then each child folder holding one. */
export function stacks(): Stack[] {
  const here = nearestStack('.')
  const below = children().filter(holdsStack)

  return [...(here ? [here] : []), ...below.filter(dir => dir !== here?.dir).map(stackAt)]
}

/** The compose projects with containers, one entry each, from the labels compose put on them. */
export function labelled(text: string): Labels[] {
  const projects = new Map<string, Labels>()

  for (const line of text.split('\n')) {
    const [project, files, envFiles = '', workdir = ''] = line.split('\t')

    if (project !== undefined && project !== '' && files !== undefined && files !== '' && workdir !== '' && !projects.has(project))
      projects.set(project, { project, files: files.split(','), envFiles: envFiles.split(',').filter(Boolean), workdir })
  }

  return [...projects.values()]
}

/** A stack whose files were renamed or deleted since it came up is left out, there being nothing to run it with. */
export async function labels(project?: string): Promise<Labels[]> {
  const filter = project === undefined ? [] : ['--filter', `label=com.docker.compose.project=${project}`]
  const proc = Bun.spawn(['docker', 'ps', '--all', ...filter, '--format', LABEL_FORMAT], { stdout: 'pipe', stderr: 'ignore' })

  if ((await proc.exited) !== 0)
    return []

  return labelled(await new Response(proc.stdout).text()).filter(stack => [...stack.files, ...stack.envFiles].every(file => existsSync(file)))
}

/** Run from the folder it came up in, with the files it came up with, paths kept short from there. */
export function labelledStack(dir: string, { project, files, envFiles, workdir }: Labels): Stack {
  const options = (paths: (file: string) => string) => ['-p', project, ...files.flatMap(file => ['-f', paths(file)]), ...envFiles.flatMap(file => ['--env-file', paths(file)])]

  return {
    dir,
    project,
    run: from(dir, ['docker', 'compose', ...options(file => relative(workdir, file))]),
    list: { argv: ['docker', 'compose', ...options(file => file)], cwd: workdir, env: process.env },
  }
}

export function stackOf(recorded: Labels): Stack {
  return labelledStack(relative('.', recorded.workdir) || '.', recorded)
}

/** The stacks with containers that came up from this folder, a parent up to the repository root, or a child folder. */
export async function recordedNearby(): Promise<Labels[]> {
  const dirs = new Set([...up('.'), ...children()].map(dir => resolve(dir)))

  return (await labels()).filter(stack => dirs.has(stack.workdir))
}

export async function output(stack: Stack, args: string[]): Promise<string> {
  const proc = Bun.spawn([...stack.list.argv, ...args], { cwd: stack.list.cwd, env: stack.list.env, stdout: 'pipe', stderr: 'pipe' })

  return (await proc.exited) === 0 ? new Response(proc.stdout).text() : ''
}

/** Compose prints one container per line, where older versions printed a JSON array. */
export function containers(text: string): Container[] {
  const trimmed = text.trim()

  if (!trimmed)
    return []

  return trimmed.startsWith('[') ? JSON.parse(trimmed) as Container[] : trimmed.split('\n').map(line => JSON.parse(line) as Container)
}

export async function services(stack: Stack): Promise<Service[]> {
  const [config, ps] = await Promise.all([output(stack, ['config', '--format', 'json']), output(stack, ['ps', '--all', '--format', 'json'])])
  const parsed = config ? JSON.parse(config) as Config : {}
  const declared = parsed.services ?? {}
  const project = stack.project ?? parsed.name ?? ''
  const running = new Map(containers(ps).map(container => [container.Service, container]))

  return Object.entries(declared).map(([name, service]) => ({
    stack,
    project,
    name,
    state: running.get(name)?.State ?? 'none',
    status: running.get(name)?.Status ?? '',
    ports: (service.ports ?? []).filter(port => (port.published ?? '') !== '').map(port => `${port.published}->${port.target}`).join(' '),
    image: service.image ?? 'built',
  }))
}

/** The services of the stacks compose finds on its own, then of the ones only their containers tell of. */
export async function allServices(): Promise<Service[]> {
  const [listed, recorded] = await Promise.all([Promise.all(stacks().map(services)), recordedNearby()])
  const found = listed.flat()
  const known = new Set(found.map(service => service.project))
  const others = recorded.filter(stack => !known.has(stack.project))

  return [...found, ...(await Promise.all(others.map(async stack => services(stackOf(stack))))).flat()]
}

function named(service: Service): string {
  return service.stack.project === undefined ? service.name : `${service.stack.project}:${service.name}`
}

/** What names a service: `php` in this folder's stack, `api/php` in a child's, `<project>:php` in one found through its containers. */
export function key(service: Service): string {
  return service.stack.dir === '.' ? named(service) : `${service.stack.dir}/${named(service)}`
}

/** Bash when the container has it, the images built on alpine only having sh. */
async function shellOf(service: Service): Promise<string> {
  return (await output(service.stack, ['exec', '-T', service.name, 'sh', '-c', 'command -v bash'])) ? 'bash' : 'sh'
}

export async function commandFor(service: Service, action: Action): Promise<string[]> {
  const run = service.stack.run

  switch (action) {
    case 'shell':
      return [...run, 'exec', service.name, await shellOf(service)]
    case 'logs':
      return [...run, 'logs', '-f', '--tail=200', service.name]
    case 'restart':
      return [...run, 'restart', service.name]
    case 'up':
      return [...run, 'up', '-d', service.name]
    case 'stop':
      return [...run, 'stop', service.name]
    case 'build':
      return [...run, 'up', '-d', '--build', service.name]
  }
}

/** A stopped service has no shell to open, so it is brought up instead. */
export function defaultAction(service: Service): Action {
  return service.state === 'running' ? 'shell' : 'up'
}

// Up in green, down in red, never created dimmed, anything on its way, restarting or paused, in yellow.
export function stateColor(state: string): 'green' | 'red' | 'dim' | 'yellow' {
  if (state === 'running')
    return 'green'

  if (state === 'exited' || state === 'dead')
    return 'red'

  return state === 'none' ? 'dim' : 'yellow'
}

// A service looked up again from the folder, project and name the picker's preview was given.
export async function serviceNamed(dir: string, name: string, project: string): Promise<Service | undefined> {
  const [recorded] = project === '' ? [] : await labels(project)
  const stack = recorded === undefined ? stackAt(dir) : labelledStack(dir, recorded)

  return (await services(stack)).find(candidate => candidate.name === name)
}

// Compose's own words for its output of one service, the last lines of its logs.
export async function logsOf(stack: Stack, name: string): Promise<string> {
  return output(stack, ['logs', '--tail=30', '--no-log-prefix', name])
}
