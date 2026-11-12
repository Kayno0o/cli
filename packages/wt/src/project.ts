import type { Resolved } from './config'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { expandHome, fillTemplate, wtConfig } from './config'
import { KnownError } from './errors'
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
  repos: string[]
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
  routes: Route[]
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

// A DNS label, as the task prefixes every host of the worktree.
const TASK_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const ROUTE_TARGET = /^client$|^[\w.-]+:\d+$/

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

// Caught when the manifest loads, not halfway through a `wt add` that has already cloned data.
function assertValid(project: Project): void {
  for (const route of project.routes) {
    if (!ROUTE_TARGET.test(route.to))
      throw new WtError(`${project.name}: route ${route.host} goes to "${route.to}", expected "client" or "<service>:<port>"`)

    if (route.passthrough && project.certs === undefined)
      throw new WtError(`${project.name}: passthrough route ${route.host} needs \`certs\``)
  }
}

export async function loadProjects(): Promise<Project[]> {
  const settings = await wtConfig()
  const files = existsSync(settings.manifests) ? readdirSync(settings.manifests).filter(file => file.endsWith('.ts')).sort() : []

  const projects = await Promise.all(files.map(async (file) => {
    const { default: config } = await import(join(settings.manifests, file)) as { default: ProjectConfig }
    const project = { ...config, root: expandHome(config.root), name: basename(file, '.ts'), settings }

    assertValid(project)

    return project
  }))

  // A worktree's stack is named after its checkout's folder, kept so that running stacks keep their containers and volumes.
  for (const [index, project] of projects.entries()) {
    const twin = projects.slice(0, index).find(other => basename(other.root) === basename(project.root))

    if (twin)
      throw new WtError(`${twin.name}.ts and ${project.name}.ts both have a checkout named ${basename(project.root)}, so their worktrees would share stacks and volumes: rename one of the folders`)
  }

  return projects
}

export async function findProject(name: string): Promise<Project> {
  const project = (await loadProjects()).find(p => p.name === name)

  if (!project)
    throw new WtError(`no project named ${name} in ${(await wtConfig()).manifests}`)

  return project
}

export const tasksDir = (project: Project) => fillTemplate([project.settings.worktrees], { root: dirname(project.root), repo: basename(project.root) })[0]!

export function worktreeOf(project: Project, task: string): Worktree {
  if (task === 'main' || !TASK_PATTERN.test(task))
    throw new WtError(`invalid task name "${task}": lowercase letters, digits and inner dashes, at most 63, and not "main"`)

  const mainHosts = new Set(project.routes.map(route => route.host))
  const taken = project.routes.find(route => mainHosts.has(worktreeHost(route.host, task)))

  if (taken)
    throw new WtError(`invalid task name "${task}": the worktree's ${worktreeHost(taken.host, task)} would be one of main's hosts`)

  const id = `${basename(project.root)}--${task}`

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
    throw new WtError(`no worktree ${worktree.task}, create it with \`wt add ${worktree.task}\``)
}

export function listTasks(project: Project): string[] {
  const dir = tasksDir(project)

  return existsSync(dir) ? readdirSync(dir).filter(task => TASK_PATTERN.test(task)).sort() : []
}

// The project and task the working directory sits in, `main` when it is the project's own checkout.
export async function locate(cwd: string, projectName?: string): Promise<{ project: Project, task: string }> {
  const here = realpathSync(cwd)
  const projects = projectName !== undefined ? [await findProject(projectName)] : await loadProjects()

  for (const project of projects) {
    const dir = tasksDir(project)

    if (here.startsWith(`${dir}/`)) {
      const rest = here.slice(dir.length + 1)
      const slash = rest.indexOf('/')

      return { project, task: slash === -1 ? rest : rest.slice(0, slash) }
    }

    if (here === project.root || here.startsWith(`${project.root}/`))
      return { project, task: 'main' }
  }

  if (projects.length === 1)
    return { project: projects[0]!, task: 'main' }

  throw new WtError('not inside a known project or worktree (cd into one, or pass --project)')
}

export async function locateWorktree(cwd: string, task: string | undefined, projectName?: string): Promise<Worktree> {
  const here = await locate(cwd, projectName)
  const name = task ?? here.task

  if (name === 'main')
    throw new WtError('this is the main checkout, name a task')

  return worktreeOf(here.project, name)
}
