import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fail, runCommand, warn } from '@kaynooo/cli-kit'
import { shellQuote } from '@kaynooo/cli-kit/shell'

// The files `docker compose` reads on its own, a project's own first and its override merged over it.
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
const OVERRIDE_FILES = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yaml', 'docker-compose.override.yml']
const PS_TIMEOUT_MS = 20_000
const VARIABLE = /\$\{(\w+)(?::?-([^${}]*))?\}|\$(\w+)/g
const ENV_LINE = /^\s*(?:export\s+)?(\w+)=(.*)$/
const QUOTED = /^(['"])(.*)\1$/

// What a step needs to run: the service that mounts its folder, where its compose project lives and the folder's path inside the container.
export interface Placement {
  service: string
  composeDir: string
  workdir: string
}

export interface Mount {
  source: string
  target: string
}

export interface Service {
  name: string
  mounts: Mount[]
  // Name, image and build, lowercased, what tells a PHP service from a Bun one.
  profile: string
}

interface RawService {
  image?: unknown
  build?: unknown
  volumes?: unknown
}

export interface PlaceSettings {
  // Forces this service, failing when the folder is not mounted in it.
  service?: string | undefined
  // Forces the host.
  host?: boolean | undefined
}

// Words in a service's name, image or build that say it runs a tool.
const TOOL_WORDS: Record<string, string[]> = {
  bun: ['bun'],
  bunx: ['bun'],
  node: ['node', 'bun'],
  npm: ['node', 'bun'],
  npx: ['node', 'bun'],
  pnpm: ['node', 'bun'],
  yarn: ['node', 'bun'],
  composer: ['php'],
  php: ['php'],
  phpunit: ['php'],
  phpstan: ['php'],
  paratest: ['php'],
  pest: ['php'],
  symfony: ['php'],
}

// The words that tell which service runs a command, from its program: `bun run lint` and `vendor/bin/phpunit` have one, `make test` none.
export function toolWords(program: string): string[] {
  const name = basename(program)

  return TOOL_WORDS[name] ?? (program.includes('vendor/bin/') ? ['php'] : [])
}

interface ComposeFile {
  name: string
  text: string
}

async function readFiles(dir: string, names: string[]): Promise<ComposeFile | undefined> {
  for (const name of names) {
    const handle = Bun.file(join(dir, name))

    if (await handle.exists())
      return { name, text: await handle.text() }
  }

  return undefined
}

// Variables a compose file can interpolate: the process's, then the project's .env.
async function variables(composeDir: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  const text = (await readFiles(composeDir, ['.env']))?.text ?? ''

  for (const line of text.split('\n')) {
    const match = ENV_LINE.exec(line)

    if (match !== null && !line.trimStart().startsWith('#'))
      env[match[1] ?? ''] = (match[2] ?? '').trim().replace(QUOTED, '$2')
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined)
      env[key] = value
  }

  // The shell docker compose is run from is the project's folder.
  env.PWD = composeDir

  return env
}

function interpolate(text: string, env: Record<string, string>): string {
  let current = text

  for (let round = 0; round < 4 && current.includes('$'); round++) {
    current = current.replaceAll(VARIABLE, (_, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
      const value = env[braced ?? bare ?? '']

      return value !== undefined && value !== '' ? value : fallback ?? ''
    })
  }

  return current
}

// The folder a bind mount's source names, undefined for a named volume.
function bindSource(source: string, composeDir: string, env: Record<string, string>): string | undefined {
  const path = interpolate(source, env)

  if (path.startsWith('~'))
    return join(homedir(), path.slice(1))

  if (path.startsWith('/'))
    return resolve(path)

  return path.startsWith('.') ? resolve(composeDir, path) : undefined
}

function mountsOf(volumes: unknown, composeDir: string, env: Record<string, string>): Mount[] {
  if (!Array.isArray(volumes))
    return []

  const mounts: Mount[] = []

  for (const volume of volumes as unknown[]) {
    let source: string | undefined
    let target: string | undefined

    if (typeof volume === 'string') {
      [source, target] = interpolate(volume, env).split(':')
    }
    else if (typeof volume === 'object' && volume !== null) {
      const object = volume as { type?: unknown, source?: unknown, target?: unknown }

      if (object.type === 'bind' && typeof object.source === 'string' && typeof object.target === 'string')
        ({ source, target } = object as { source: string, target: string })
    }

    const resolved = source === undefined ? undefined : bindSource(source, composeDir, env)

    if (resolved !== undefined && target?.startsWith('/') === true)
      mounts.push({ source: resolved, target })
  }

  return mounts
}

function buildText(build: unknown): string {
  if (typeof build === 'string')
    return build

  return typeof build === 'object' && build !== null ? Object.values(build).filter(value => typeof value === 'string').join(' ') : ''
}

function parseServices(text: string, composeDir: string, env: Record<string, string>): Map<string, RawService & { mounts: Mount[] }> {
  const services = new Map<string, RawService & { mounts: Mount[] }>()
  const parsed = Bun.YAML.parse(text) as { services?: Record<string, RawService | null> } | null

  for (const [name, service] of Object.entries(parsed?.services ?? {})) {
    if (service !== null && typeof service === 'object')
      services.set(name, { ...service, mounts: mountsOf(service.volumes, composeDir, env) })
  }

  return services
}

// The files of the project in a folder, in merge order: the ones COMPOSE_FILE names (from the environment or the project's .env), else the base file and its override. Empty when the folder has none.
async function composeFiles(composeDir: string, env: Record<string, string>): Promise<ComposeFile[]> {
  const listed = env.COMPOSE_FILE

  if (listed !== undefined && listed !== '') {
    const files: ComposeFile[] = []
    const separator = env.COMPOSE_PATH_SEPARATOR

    for (const name of listed.split(separator === undefined || separator === '' ? ':' : separator).filter(entry => entry !== '')) {
      const file = Bun.file(resolve(composeDir, name))

      if (!await file.exists())
        return []

      files.push({ name, text: await file.text() })
    }

    return files
  }

  const base = await readFiles(composeDir, COMPOSE_FILES)

  if (base === undefined)
    return []

  const override = await readFiles(composeDir, OVERRIDE_FILES)

  return override === undefined ? [base] : [base, override]
}

// The services of the compose project in a folder, each later file's mounts added to the earlier ones'; undefined when the folder has no project, a failure naming the file when one does not parse.
export async function readServices(composeDir: string): Promise<Service[] | undefined> {
  const env = await variables(composeDir)
  const files = await composeFiles(composeDir, env)

  if (files.length === 0)
    return undefined

  const services = new Map<string, RawService & { mounts: Mount[] }>()

  for (const file of files) {
    let parsed: Map<string, RawService & { mounts: Mount[] }>

    try {
      parsed = parseServices(file.text, composeDir, env)
    }
    catch (error) {
      fail(`cannot read ${join(composeDir, file.name)}: ${error instanceof Error ? error.message : String(error)}`, 1, 'fix the file, or run on the host with --host')
    }

    for (const [name, extra] of parsed) {
      const known = services.get(name)

      services.set(name, known === undefined ? extra : { ...known, ...extra, mounts: [...known.mounts, ...extra.mounts], image: extra.image ?? known.image, build: extra.build ?? known.build })
    }
  }

  return [...services].map(([name, service]) => ({ name, mounts: service.mounts, profile: `${name} ${typeof service.image === 'string' ? service.image : ''} ${buildText(service.build)}`.toLowerCase() }))
}

// The folders from `dir` up to the one holding .git, `dir` alone outside a repository.
function climb(dir: string): string[] {
  const folders = [dir]
  let current = dir

  while (!existsSync(join(current, '.git')) && dirname(current) !== current) {
    current = dirname(current)
    folders.push(current)
  }

  return existsSync(join(current, '.git')) ? folders : [dir]
}

// The deepest mount of the service holding `dir`, as the path of `dir` inside the container.
function containerPath(service: Service, dir: string): string | undefined {
  const holding = service.mounts.filter((mount) => {
    const inside = relative(mount.source, dir)

    return !inside.startsWith('..') && !inside.startsWith('/')
  })
  const deepest = holding.toSorted((a, b) => b.source.length - a.source.length)[0]

  if (deepest === undefined)
    return undefined

  const inside = relative(deepest.source, dir)

  return inside === '' ? deepest.target : join(deepest.target, inside)
}

// The projects already reported as run on the host for lack of docker, so the notice comes once.
const noticed = new Set<string>()

// The service of the nearest compose project that bind-mounts `dir`, or undefined to run on the host. A service that is down is not skipped here, as the answer must not depend on what runs. Several services mounting it: the one whose name, image or build names the command's tool, else the call fails asking for --in.
export async function place(dir: string, program: string, { service, host }: PlaceSettings = {}): Promise<Placement | undefined> {
  if (host === true)
    return undefined

  let found: { composeDir: string, services: Service[], mounting: Service[] } | undefined

  for (const composeDir of climb(dir)) {
    const services = await readServices(composeDir)
    const mounting = (services ?? []).filter(candidate => containerPath(candidate, dir) !== undefined)

    if (services !== undefined && (mounting.length > 0 || services.some(candidate => candidate.name === service))) {
      found = { composeDir, services, mounting }

      break
    }
  }

  if (found === undefined) {
    if (service !== undefined)
      fail(`--in ${service}: no compose project mounts ${dir}`)

    return undefined
  }

  // Without docker (a devcontainer, CI) there is no container to reach.
  if (Bun.which('docker', { PATH: process.env.PATH ?? '' }) === null) {
    if (service !== undefined)
      fail(`--in ${service}: docker not found`)

    if (!noticed.has(found.composeDir)) {
      noticed.add(found.composeDir)
      warn(`host, docker not found: the compose project in ${found.composeDir} is not reached`)
    }

    return undefined
  }

  const chosen = choose(found.mounting, found.services, dir, program, service)

  return { service: chosen.name, composeDir: found.composeDir, workdir: containerPath(chosen, dir) ?? dir }
}

function choose(mounting: Service[], services: Service[], dir: string, program: string, service: string | undefined): Service {
  if (service !== undefined) {
    const named = mounting.find(candidate => candidate.name === service)

    if (named === undefined)
      fail(`--in ${service}: ${services.some(candidate => candidate.name === service) ? `the service does not mount ${dir}` : `no such service, found ${services.map(candidate => candidate.name).join(', ')}`}`)

    return named
  }

  const [only] = mounting

  if (mounting.length === 1 && only !== undefined)
    return only

  const words = toolWords(program)
  const fitting = mounting.filter(candidate => words.some(word => candidate.profile.includes(word)))
  const [fit] = fitting

  if (fitting.length !== 1 || fit === undefined)
    fail(`${mounting.map(candidate => candidate.name).join(', ')} all mount ${dir} and none stands out for ${basename(program)}: pick one with --in <service>, or run on the host with --host`)

  return fit
}

// `docker compose exec` for a command, as the words after the service name.
function execArgv(placement: Placement, argv: string[], env: Record<string, string>): string[] {
  const variables = Object.entries({ NO_COLOR: '1', FORCE_COLOR: '0', ...env }).flatMap(([name, value]) => ['-e', `${name}=${value}`])

  return ['docker', 'compose', 'exec', '-T', '-w', placement.workdir, ...variables, placement.service, ...argv]
}

// A shell command string running `command` in the service, with `env` set for it.
export function shellIn(placement: Placement, command: string, env: Record<string, string> = {}): string {
  return `cd ${shellQuote(placement.composeDir)} && ${execArgv(placement, ['sh', '-c', command], env).map(word => shellQuote(word)).join(' ')}`
}

// The argv running `argv` in the service, to be spawned from the compose project's folder.
export function argvIn(placement: Placement, argv: string[]): string[] {
  return execArgv(placement, argv, {})
}

// Asks docker which services of a project run, remembering the answer for the rest of the process; the stack is never started.
export class Stack {
  private readonly answers = new Map<string, Promise<string[] | string>>()

  private async ask(composeDir: string): Promise<string[] | string> {
    let answer = this.answers.get(composeDir)

    if (answer === undefined) {
      answer = Stack.running(composeDir)
      this.answers.set(composeDir, answer)
    }

    return answer
  }

  private static async running(composeDir: string): Promise<string[] | string> {
    try {
      const ran = await runCommand(['docker', 'compose', 'ps', '--services', '--status', 'running'], { cwd: composeDir, env: process.env, timeoutMs: PS_TIMEOUT_MS })

      if (ran.code !== 0)
        return `docker compose ps failed in ${composeDir}: ${ran.text.trim().split('\n').at(-1) ?? `exit ${ran.code}`}`

      return ran.text.split('\n').map(line => line.trim()).filter(line => line !== '')
    }
    catch (error) {
      return `cannot run docker compose in ${composeDir}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  // Why the service cannot be run in, undefined when it is up.
  async problem(placement: Placement): Promise<string | undefined> {
    const answer = await this.ask(placement.composeDir)

    if (typeof answer === 'string')
      return answer

    return answer.includes(placement.service) ? undefined : `the ${placement.service} service is not running (compose project in ${placement.composeDir}): start it yourself, or run on the host with --host`
  }
}

// The first word of a shell command, the program it runs.
export function programOf(command: string): string {
  const end = command.indexOf(' ')

  return end === -1 ? command : command.slice(0, end)
}

export const placeOptions = {
  in: { type: 'string', description: 'run in this compose service instead of the one found mounting the folder' },
  host: { type: 'boolean', description: 'run on the host even when a compose service mounts the folder' },
} as const

// The --in and --host the user gave, refusing both.
export function placeSettings(values: { in?: string | undefined, host?: boolean | undefined }): PlaceSettings {
  if (values.in !== undefined && values.host === true)
    fail('--in and --host exclude each other')

  return { service: values.in, host: values.host }
}
