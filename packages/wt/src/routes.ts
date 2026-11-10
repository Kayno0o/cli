import type { Worktree } from './project'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $ } from 'bun'
import { worktreeHost, WtError } from './project'

const LEADING_STAR = /^\*/

async function mkcert(certFile: string, keyFile: string, hosts: string[]): Promise<void> {
  const result = await $`mkcert -cert-file ${certFile} -key-file ${keyFile} ${hosts}`.quiet().nothrow()

  if (result.exitCode !== 0)
    throw new WtError(`mkcert failed for ${hosts.join(' ')}:\n${result.stderr.toString()}`)
}

/**
 * devproxy serves the worktree's hosts from the labels of its override and makes their certificates; a project with `certs` terminates its passthrough hosts in its own nginx, which picks one certificate per host by name, named the way mkcert names them.
 * A certificate without its key, or the other way round, is issued again.
 */
export async function writeStackCerts(worktree: Worktree): Promise<void> {
  const { project } = worktree

  if (project.certs === undefined)
    return

  const dir = join(worktree.dir, project.certs)

  mkdirSync(dir, { recursive: true })

  await Promise.all(project.routes.map(async (route) => {
    const served = worktreeHost(route.host, worktree.task)
    const name = served.replace(LEADING_STAR, '_wildcard')
    const cert = join(dir, `${name}.pem`)
    const key = join(dir, `${name}-key.pem`)

    return existsSync(cert) && existsSync(key) ? undefined : mkcert(cert, key, [served])
  }))
}

export function urlsOf(worktree: Worktree): string[] {
  return worktree.project.routes.filter(route => !route.host.startsWith('*.')).map(route => `https://${worktreeHost(route.host, worktree.task)}`)
}
