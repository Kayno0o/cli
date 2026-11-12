/** The shared proxy is devproxy (@kaynooo/devproxy): the one on PATH, else the copy installed with wt. */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configBase } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { WtError } from './project'

export interface ProxyHost {
  host: string
  // null for a route of the config, else the group holding it: docker-<project> for the labels of a running stack.
  group: string | null
  to: string
  passthrough: boolean
}

// PATH first, so a test sandbox's fake answers instead of the real one. The installed copy runs with devproxy's own shebang flags, so the cwd's .env (a worktree's COMPOSE_PROJECT_NAME) stays out of it.
export function devproxyArgv(path = process.env.PATH ?? ''): string[] {
  const onPath = Bun.which('devproxy', { PATH: path })

  if (onPath !== null)
    return [onPath]

  try {
    return [process.execPath, '--no-env-file', '--config=/dev/null', join(dirname(Bun.resolveSync('@kaynooo/devproxy', import.meta.dir)), '..', 'dist', 'cli.js')]
  }
  catch {
    return []
  }
}

/** Whether devproxy is installed and has a config to serve, so wt routes through it: its config file looked up as devproxy does, so `up` spawns it once. */
export function hasDevproxy(): boolean {
  return devproxyArgv().length > 0 && existsSync(process.env.DEVPROXY_CONFIG ?? join(configBase(), 'devproxy', 'config.ts'))
}

/** Every host the proxy serves; empty without devproxy or its config. */
export async function proxyHostList(): Promise<ProxyHost[]> {
  const argv = devproxyArgv()
  const result = argv.length ? await $`${argv} hosts --json`.quiet().nothrow() : undefined

  return result?.exitCode === 0 ? JSON.parse(result.stdout.toString()) as ProxyHost[] : []
}

/** Generates the proxy's files and starts it, network included; output goes to the terminal. */
export async function devproxyUp(): Promise<void> {
  const argv = devproxyArgv()

  if (!argv.length || (await $`${argv} up`.nothrow()).exitCode !== 0)
    throw new WtError('the shared proxy did not come up: `devproxy status` says why')
}
