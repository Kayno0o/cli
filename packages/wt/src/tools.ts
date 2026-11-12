/** The programs wt runs, found on PATH: `wt add` checks the ones it will need before changing anything, `wt doctor` lists them all. */

import type { Project } from './project'
import { table } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { WtError } from './project'
import { devproxyArgv } from './proxy'

interface Tool {
  name: string
  /** What wt runs it for. */
  for: string
  /** How to get it. */
  get: string
  /** Whether a project needs it; one no project needs is optional. */
  needed?: (project: Project) => boolean
  /** Where it is, or undefined when it is missing. */
  find?: () => Promise<string | undefined> | string | undefined
}

const always = () => true

// devproxy is installed with wt, so only a broken install misses it
function findDevproxy(): string | undefined {
  return devproxyArgv().at(-1)
}

// docker without its compose plugin cannot run a stack
async function findCompose(): Promise<string | undefined> {
  const docker = Bun.which('docker')

  if (docker === null)
    return undefined

  const version = await $`${docker} compose version --short`.quiet().nothrow()

  return version.exitCode === 0 ? `${docker} compose ${version.text().trim()}` : undefined
}

const TOOLS: Tool[] = [
  { name: 'git', for: 'checks the worktrees out', get: 'the git package of the system', needed: always },
  { name: 'docker', for: 'reads the compose project, clones its volumes and runs the stacks', get: 'https://docs.docker.com/engine/install/', needed: always },
  { name: 'docker compose', for: 'runs the stacks', get: 'the docker compose plugin, https://docs.docker.com/compose/install/linux/', needed: always, find: findCompose },
  { name: 'mkcert', for: 'issues the certificates of a project with `certs`', get: 'https://github.com/FiloSottile/mkcert, then `mkcert -install`', needed: project => project.certs !== undefined },
  { name: 'devproxy', for: 'routes the subdomains', get: 'installed with wt, else `bun add -g @kaynooo/devproxy`', find: findDevproxy },
  { name: 'notify-send', for: 'tells a --bg job is over', get: 'the libnotify package of the system' },
]

async function locateTool(tool: Tool): Promise<string | undefined> {
  return tool.find ? tool.find() : Bun.which(tool.name) ?? undefined
}

/** Refuses before anything is made when a program the project needs is missing, naming each with how to get it. */
export async function assertTools(project: Project): Promise<void> {
  const needed = TOOLS.filter(tool => tool.needed?.(project) === true)
  const found = await Promise.all(needed.map(locateTool))
  const missing = needed.filter((_, index) => found[index] === undefined)

  if (missing.length)
    throw new WtError(`${missing.map(tool => `${tool.name} is not on PATH, ${tool.get}`).join('\n')}\nwt needs it for ${project.name}: \`wt doctor\` lists every program`)
}

/** Prints each program wt runs, where it is or how to get it; 1 when one the projects need is missing. */
export async function doctor(projects: Project[]): Promise<number> {
  const found = await Promise.all(TOOLS.map(locateTool))
  let code = 0

  const rows = TOOLS.map((tool, index) => {
    const at = found[index]
    const neededBy = tool.needed === undefined ? [] : projects.filter(tool.needed).map(project => project.name)
    const required = tool.needed === always || neededBy.length > 0

    if (at === undefined && required)
      code = 1

    const use = tool.needed === undefined || tool.needed === always ? tool.for : `${tool.for}${neededBy.length ? ` (${neededBy.join(', ')})` : ', no project has them'}`

    const state = required ? 'missing' : 'absent'

    return [at === undefined ? state : 'ok', tool.name, at ?? tool.get, use]
  })

  console.log(table([['', 'program', 'where', 'for'], ...rows], { header: true }))

  return code
}
