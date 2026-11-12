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
  /** Whether wt needs it: for every project, for the ones it picks, or never, only for comfort. */
  needs: 'always' | 'optional' | ((project: Project) => boolean)
  /** Where it is, or undefined when it is missing. */
  find?: () => Promise<string | undefined> | string | undefined
}

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
  { name: 'git', for: 'checks the worktrees out', get: 'the git package of the system', needs: 'always' },
  { name: 'docker', for: 'reads the compose project, clones its volumes and runs the stacks', get: 'https://docs.docker.com/engine/install/', needs: 'always' },
  { name: 'docker compose', for: 'runs the stacks', get: 'the docker compose plugin, https://docs.docker.com/compose/install/linux/', needs: 'always', find: findCompose },
  { name: 'mkcert', for: 'issues the certificates of a project with `certs`', get: 'https://github.com/FiloSottile/mkcert, then `mkcert -install`', needs: project => project.certs !== undefined },
  { name: 'devproxy', for: 'routes the subdomains', get: 'installed with wt, else `bun add -g @kaynooo/devproxy`', needs: 'optional', find: findDevproxy },
  { name: 'notify-send', for: 'tells a --bg job is over', get: 'the libnotify package of the system', needs: 'optional' },
]

function neededBy(tool: Tool, project: Project): boolean {
  return typeof tool.needs === 'function' ? tool.needs(project) : tool.needs === 'always'
}

async function locateTool(tool: Tool): Promise<string | undefined> {
  return tool.find ? tool.find() : Bun.which(tool.name) ?? undefined
}

/** Refuses before anything is made when a program the project needs is missing, naming each with how to get it. */
export async function assertTools(project: Project): Promise<void> {
  const needed = TOOLS.filter(tool => neededBy(tool, project))
  const found = await Promise.all(needed.map(locateTool))
  const missing = needed.filter((_, index) => found[index] === undefined)

  if (missing.length)
    throw new WtError(`${missing.map(tool => `${tool.name} is not on PATH, ${tool.get}`).join('\n')}\nwt needs it for ${project.name}`, '`wt doctor` lists every program')
}

/** Prints each program wt runs, where it is or how to get it; 1 when one the projects need is missing. */
export async function doctor(projects: Project[]): Promise<number> {
  const found = await Promise.all(TOOLS.map(locateTool))
  let code = 0

  const rows = TOOLS.map((tool, index) => {
    const at = found[index]
    const by = projects.filter(project => neededBy(tool, project)).map(project => project.name)
    const required = tool.needs === 'always' || by.length > 0
    let use = tool.for

    if (typeof tool.needs === 'function')
      use += by.length ? ` (${by.join(', ')})` : ', no project has them'

    if (at !== undefined)
      return ['ok', tool.name, at, use]

    if (required)
      code = 1

    return [required ? 'missing' : 'absent', tool.name, tool.get, use]
  })

  console.log(table([['', 'program', 'where', 'for'], ...rows], { header: true }))

  return code
}
