/** Brings a worktree's stack up and down: the config's `runner` commands when it has them, else compose in the worktree, the manifest's `setup` run once after the first up. */

import type { Worktree } from './project'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { warn } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { composeEnv } from './compose'
import { configPath, fillTemplate } from './config'
import { WtError } from './project'
import { devproxyUp, hasDevproxy } from './proxy'

// The env is always passed: a spawn given none gets the env the process started with, missing the WT_JOBS_HELD a job sets since.
async function spawnInherit(argv: string[], cwd: string, env: Record<string, string | undefined> = process.env): Promise<number> {
  return Bun.spawn(argv, { cwd, env, stdio: ['inherit', 'inherit', 'inherit'] }).exited
}

type Role = 'up' | 'down' | 'removed'

/** Spawns a `runner` command, one whose executable is missing (a shell function, a bin not installed) failing with the config line to fix. */
async function spawnRunner(role: Role, argv: string[], cwd: string): Promise<number> {
  try {
    return await spawnInherit(argv, cwd)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new WtError(`\`${argv[0]}\` is not on PATH: fix runner.${role} in ${configPath()}`)

    throw error
  }
}

const argvOf = (template: string[], worktree: Worktree) => fillTemplate(template, { project: worktree.project.name, task: worktree.task, dir: worktree.dir, id: worktree.id })

/** Runs a `runner` template, failing with the command named. */
async function runTemplate(role: Role, template: string[], worktree: Worktree): Promise<void> {
  const argv = argvOf(template, worktree)

  if (await spawnRunner(role, argv, worktree.dir) !== 0)
    throw new WtError(`\`${argv.join(' ')}\` failed`)
}

/** The manifest's setup commands, run with sh in the worktree the first time its stack comes up; a failing one leaves them all to run again next time. */
export async function runSetup(worktree: Worktree, env: Record<string, string | undefined> = composeEnv()): Promise<void> {
  const setup = worktree.project.setup ?? []
  const marker = worktree.files.setupMarker

  if (!setup.length || existsSync(marker))
    return

  for (const command of setup) {
    if (await spawnInherit(['sh', '-c', command], worktree.dir, env) !== 0)
      throw new WtError(`the worktree setup failed on \`${command}\``)
  }

  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(marker, '')
}

export async function stackUp(worktree: Worktree): Promise<void> {
  const { up } = worktree.project.settings.runner

  if (up)
    return runTemplate('up', up, worktree)

  // The override puts routed services on the proxy's network, which must exist before compose starts them
  if (hasDevproxy())
    await devproxyUp()

  const network = worktree.project.settings.proxyNetwork

  if (worktree.project.routes.length > 0 && (await $`docker network inspect ${network}`.quiet().nothrow()).exitCode !== 0)
    throw new WtError(`the routed services join the ${network} network, which does not exist: install and configure devproxy, or set proxyNetwork in ${configPath()} to the network your proxy dials stacks on`)

  if (await spawnInherit(['docker', 'compose', 'up', '-d', '--build'], worktree.dir, composeEnv()) !== 0)
    throw new WtError(`docker compose up failed in ${worktree.dir}`)

  await runSetup(worktree)
}

/** Stops the stack; with the worktree's folder gone, compose finds its containers by their project label. */
export async function stackDown(worktree: Worktree): Promise<void> {
  const { down } = worktree.project.settings.runner

  if (down && existsSync(worktree.dir))
    return runTemplate('down', down, worktree)

  const here = existsSync(worktree.dir)
  // Away from the project, whose compose file compose would otherwise read under the worktree's name
  const argv = here ? ['docker', 'compose', 'down', '--remove-orphans'] : ['docker', 'compose', '-p', worktree.id, 'down', '--remove-orphans']

  if (await spawnInherit(argv, here ? worktree.dir : homedir(), composeEnv()) !== 0)
    throw new WtError(`docker compose down failed for ${worktree.id}`)
}

/** Follows the stack's compose logs from their last 100 lines until interrupted, returning compose's exit code. */
export async function followLogs(worktree: Worktree): Promise<number> {
  return spawnInherit(['docker', 'compose', 'logs', '--follow', '--tail', '100'], worktree.dir, composeEnv())
}

/** Runs the config's `removed` command once a worktree is gone, from the project's root. */
export async function afterRemove(worktree: Worktree): Promise<void> {
  const { removed } = worktree.project.settings.runner

  if (!removed)
    return

  const argv = argvOf(removed, worktree)

  try {
    if (await spawnRunner('removed', argv, worktree.project.root) !== 0)
      warn(`\`${argv.join(' ')}\` failed after removing ${worktree.id}`)
  }
  catch (error) {
    // The worktree is gone already: what is left to do is said, not failed on
    if (!(error instanceof WtError))
      throw error

    warn(`${error.message}, after removing ${worktree.id}`)
  }
}

/** Whether some container, running or not, belongs to that compose project. */
export async function hasContainers(composeName: string): Promise<boolean> {
  const found = await $`docker ps -aq --filter ${`label=com.docker.compose.project=${composeName}`}`.quiet().nothrow()

  return found.stdout.toString().trim() !== ''
}
