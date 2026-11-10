/** The shared proxy is devproxy (@kaynooo/devproxy): the one on PATH, else the copy installed with wt. */

import { dirname, join } from 'node:path'
import { $ } from 'bun'
import { WtError } from './project'

export interface ProxyHost {
  host: string
  // null for a route of the config, else the group holding it: docker-<project> for the labels of a running stack.
  group: string | null
  to: string
  passthrough: boolean
}

// PATH first, so a test sandbox's fake answers instead of the real one.
function devproxyArgv(): string[] {
  const onPath = Bun.which('devproxy')

  if (onPath !== null)
    return [onPath]

  try {
    return [process.execPath, join(dirname(Bun.resolveSync('@kaynooo/devproxy', import.meta.dir)), '..', 'dist', 'cli.js')]
  }
  catch {
    return []
  }
}

/** Whether devproxy is installed and has a config to serve, so wt routes through it. */
export async function hasDevproxy(): Promise<boolean> {
  const argv = devproxyArgv()

  return argv.length > 0 && (await $`${argv} hosts --json`.quiet().nothrow()).exitCode === 0
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
