import type { Resolved } from './config'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { warn } from '@kaynooo/cli-kit'
import { expandHome, fillTemplate, wtConfig } from './config'
import { failureText, KnownError } from './errors'
import { stringToPort } from './port'

export interface Route {
  // The host the main stack answers on: a worktree answers on <task>.<host>, and *.<rest> becomes *.<task>.<rest>.
  host: string
  // 'client' for the dev server on the host, '<service>:<port>' for a container of the stack.
  to: 'client' | `${string}:${number}`
  // TLS stays with the stack's own nginx, which finds its certificate in `certs` under the host name.
  passthrough?: boolean
}

export interface ProjectConfig {
  // Checkout the worktrees are made from.
  root: string
  // Nested repos checked out on the task branch, the root then a detached worktree; with none, the root itself is on the branch.
  repos?: string[]
  // Gitignored files and dirs copied from main. Hosts in the `.env*` files among them are rewritten.
  copy?: string[]
  // Data each worktree gets its own copy of: a path under root, or the key of a named volume.
  clone?: string[]
  // Paths shared with main through a symlink.
  link?: string[]
  // Services left out of a worktree stack, typically one on the host network.
  skip?: string[]
  // Services dialling the stack's own hosts from inside a container. Only the shared proxy answers for
  // those, and a project's own override only names main's, so the worktree's go into their /etc/hosts.
  routeHosts?: string[]
  // Values forced into copied env files, `{task}` standing for the task name and `{port}` for its dev server port.
  env?: Record<string, Record<string, string>>
  // Where the stack's own nginx reads certificates from, relative to root. Required by passthrough routes.
  certs?: string
  // Commands run once with sh, in the worktree, the first time its stack comes up.
  setup?: string[]
  // What `wt run` needs to run a command of the worktree in a throwaway container, beside its own test database.
  run?: RunConfig
  // The hosts devproxy routes to the worktree's stack; none leaves it unrouted.
  routes?: Route[]
}

export interface RunConfig {
  // The compose service whose image runs the command, the worktree's `dir` mounted where main's is.
  service: string
  // Directory of the checkout the service bind-mounts, whose test env files name the database.
  dir: string
  // Shell commands run in that container, test env, the first time a worktree meets a fresh database: schema and fixtures, never a dump of dev data.
  provision: string[]
  // Resolver for the container, "127.0.0.1" when the tests look up outside hosts and Docker's forward to the host resolver takes seconds to fail each one.
  dns?: string
  // Variables the command runs with besides HOME and TEST_TOKEN, such as `APP_ENV: 'test'`.
  env?: Record<string, string>
}

export interface Project extends ProjectConfig {
  repos: string[]
  routes: Route[]
  name: string
  // The wt config the manifest was loaded under, so every path below follows it.
  settings: Resolved
}

export interface Worktree {
  project: Project
  task: string
  dir: string
  // Compose project name, also the prefix of every name wt creates for this worktree.
  id: string
  clientPort: number
  files: ReturnType<typeof worktreeFiles>
}

export class WtError extends KnownError {}

// A DNS label, as the task prefixes every host of the worktree, without the `--` that joins a project to its task in a slug: task b--c of project a would share a--b--c with task c of project a--b.
const TASK_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const ROUTE_TARGET = /^client$|^[\w.-]+:\d+$/
const NOT_IN_STACK_NAME = /[^\w-]/g
const LEADING_SEPARATORS = /^[_-]+/

// Every file wt generates for a worktree outside of it, so `wt rm` has one list to delete.
export function worktreeFiles(settings: Resolved, id: string) {
  return {
    override: join(settings.overrides, `${id}.override.yml`),
    setupMarker: join(settings.state, `${id}.setup`),
    // The volumes a clone started filling and has not finished, one per line, so the next sync empties and fills them again.
    clonesPending: join(settings.state, `${id}.clones-pending`),
  }
}

export function worktreeHost(host: string, task: string): string {
  return host.startsWith('*.') ? `*.${task}.${host.slice(2)}` : `${task}.${host}`
}

const PROJECT_KEYS = new Set(['root', 'repos', 'copy', 'clone', 'link', 'skip', 'routeHosts', 'env', 'certs', 'setup', 'run', 'routes'])
const RUN_KEYS = new Set(['service', 'dir', 'provision', 'dns', 'env'])

// A misspelt key is ignored as if it were absent, so it is named rather than silently dropped.
function warnUnknownKeys(name: string, config: ProjectConfig): void {
  const unknown = [
    ...Object.keys(config).filter(key => !PROJECT_KEYS.has(key)),
    ...Object.keys(config.run ?? {}).filter(key => !RUN_KEYS.has(key)).map(key => `run.${key}`),
  ]

  for (const key of unknown)
    warn(`${name}.ts: unknown key ${key}, ignored`)
}

// Caught when the manifest loads, not halfway through a `wt add` that has already cloned data.
function assertValid(project: Project): void {
  for (const repo of ['.', ...project.repos]) {
    const dir = join(project.root, repo)

    if (!existsSync(join(dir, '.git')))
      throw new WtError(`${project.name}: ${repo === '.' ? `root ${dir}` : `repo ${repo}`} is not a git checkout${existsSync(dir) ? '' : ', the folder is missing'}`)
  }

  for (const route of project.routes) {
    if (!ROUTE_TARGET.test(route.to))
      throw new WtError(`${project.name}: route ${route.host} goes to "${route.to}", expected "client" or "<service>:<port>"`)

    if (route.passthrough && project.certs === undefined)
      throw new WtError(`${project.name}: passthrough route ${route.host} needs \`certs\``)
  }
}

/** One manifest, checked; any failure names its file. */
async function loadManifest(settings: Resolved, file: string): Promise<Project> {
  const path = join(settings.manifests, file)
  let config: unknown

  try {
    config = ((await import(path)) as { default?: unknown }).default
  }
  catch (error) {
    throw new WtError(`${path} does not load: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (typeof config !== 'object' || config === null || typeof (config as { root?: unknown }).root !== 'string')
    throw new WtError(`${path} has no default export with a \`root\``, 'export default { root: \'~/Workspace/<checkout>\', ... } satisfies ProjectConfig')

  const manifest = config as ProjectConfig
  const project: Project = { ...manifest, repos: manifest.repos ?? [], routes: manifest.routes ?? [], root: expandHome(manifest.root), name: basename(file, '.ts'), settings }

  warnUnknownKeys(project.name, manifest)
  assertValid(project)

  // A worktree's stack is named after its checkout's folder, kept so that running stacks keep their containers and volumes.
  if (stackName(project) === '')
    throw new WtError(`${project.name}.ts: the checkout folder ${basename(project.root)} holds no letter or digit to name its compose stacks after`, 'rename the folder')

  return project
}

/** Every project whose manifest loads; one that does not is skipped, `skipped` told why (a warning by default), so it cannot break the others. */
export async function loadProjects(skipped: (message: string) => void = warn): Promise<Project[]> {
  const settings = await wtConfig()
  const files = existsSync(settings.manifests) ? readdirSync(settings.manifests).filter(file => file.endsWith('.ts')).sort() : []
  const loaded = await Promise.allSettled(files.map(async file => loadManifest(settings, file)))
  const projects: Project[] = []

  for (const result of loaded) {
    if (result.status === 'rejected') {
      skipped(`manifest skipped, ${failureText(result.reason)}`)

      continue
    }

    const project = result.value
    const twin = projects.find(other => stackName(other) === stackName(project))

    if (twin)
      skipped(`${twin.name}.ts and ${project.name}.ts both have a checkout compose names ${stackName(project)}, so their worktrees would share stacks and volumes: ${project.name} skipped, rename the folder of a checkout that has no worktrees yet, or remove one of the files`)
    else
      projects.push(project)
  }

  return projects
}

/** The project of one manifest, the others left unread: its failure to load ends the command. */
export async function findProject(name: string): Promise<Project> {
  const settings = await wtConfig()

  if (!existsSync(join(settings.manifests, `${name}.ts`)))
    throw new WtError(`no project named ${name} in ${settings.manifests}`)

  return loadManifest(settings, `${name}.ts`)
}

export const tasksDir = (project: Project) => fillTemplate([project.settings.worktrees], { root: dirname(project.root), repo: basename(project.root) })[0]!

/** The project name compose gives the checkout's folder, which its worktrees' stacks start with: lower case, only letters, digits, _ and -, none of the last two first. */
export function stackName(project: Pick<Project, 'root'>): string {
  return basename(project.root).toLowerCase().replace(NOT_IN_STACK_NAME, '').replace(LEADING_SEPARATORS, '')
}

export function worktreeOf(project: Project, task: string): Worktree {
  if (task === 'main' || !TASK_PATTERN.test(task))
    throw new WtError(`invalid task name "${task}": lowercase letters, digits and single inner dashes, at most 63, and not "main"`)

  const mainHosts = new Set(project.routes.map(route => route.host))
  const taken = project.routes.find(route => mainHosts.has(worktreeHost(route.host, task)))

  if (taken)
    throw new WtError(`invalid task name "${task}": the worktree's ${worktreeHost(taken.host, task)} would be one of main's hosts`)

  const id = `${stackName(project)}--${task}`

  return {
    project,
    task,
    dir: join(tasksDir(project), task),
    id,
    clientPort: stringToPort(`${project.name}--${task}`),
    files: worktreeFiles(project.settings, id),
  }
}

export function assertWorktreeExists(worktree: Worktree): void {
  if (!existsSync(worktree.dir))
    throw new WtError(`no worktree ${worktree.task}`, `create it with \`wt add ${worktree.task}\``)
}

export function listTasks(project: Project): string[] {
  const dir = tasksDir(project)

  return existsSync(dir) ? readdirSync(dir).filter(task => TASK_PATTERN.test(task)).sort() : []
}

// The project and task the working directory sits in, `main` when it is the project's own checkout.
/** The directory wt runs in; once deleted from under the shell (after `wt rm --bg`), the path the shell still holds, so locate reads which worktree it was. */
export function currentDir(): string {
  try {
    return process.cwd()
  }
  catch {
    const pwd = process.env.PWD ?? ''

    if (pwd === '')
      throw new WtError('the current directory is gone: cd elsewhere')

    return pwd
  }
}

// Symlinks resolved, so a cwd the kernel hands back resolved matches a root given through a link; a path gone stays as written.
function resolved(path: string): string {
  try {
    return realpathSync(path)
  }
  catch {
    return path
  }
}

export async function locate(cwd: string, projectName?: string): Promise<{ project: Project, task: string }> {
  const here = resolved(cwd)
  const projects = projectName !== undefined ? [await findProject(projectName)] : await loadProjects()

  for (const project of projects) {
    const dir = resolved(tasksDir(project))
    const root = resolved(project.root)

    if (here.startsWith(`${dir}/`)) {
      const rest = here.slice(dir.length + 1)
      const slash = rest.indexOf('/')

      return { project, task: slash === -1 ? rest : rest.slice(0, slash) }
    }

    if (here === root || here.startsWith(`${root}/`))
      return { project, task: 'main' }
  }

  if (projects.length === 1)
    return { project: projects[0]!, task: 'main' }

  if (!existsSync(cwd))
    throw new WtError(`the current directory ${cwd} is gone`, 'cd into a project or worktree, or pass --project')

  throw new WtError('not inside a known project or worktree (cd into one, or pass --project)')
}

export async function locateWorktree(cwd: string, task: string | undefined, projectName?: string): Promise<Worktree> {
  const here = await locate(cwd, projectName)
  const name = task ?? here.task

  if (name === 'main')
    throw new WtError('this is the main checkout, name a task')

  return worktreeOf(here.project, name)
}
