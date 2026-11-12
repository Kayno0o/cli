import type { Project, Worktree } from './project'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compose } from '@kaynooo/cli-kit'
import { worktreeHost, WtError } from './project'

interface ServiceNetwork {
  aliases?: string[]
}

interface ComposeService {
  container_name?: string
  image?: string
  labels?: Record<string, string>
  network_mode?: string
  networks?: Record<string, ServiceNetwork | null>
  ports?: unknown[]
  volumes?: { type: string, source?: string, target?: string }[]
}

interface ComposeVolume {
  name?: string
  external?: boolean
  driver_opts?: Record<string, string>
}

export interface ComposeConfig {
  name: string
  services: Record<string, ComposeService>
  networks?: Record<string, unknown>
  volumes?: Record<string, ComposeVolume>
}

/** The file names compose looks for in a directory, in its order. */
export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
const SKIP_PROFILE = 'wt-skip'

// Compose settings wt decides on, so a COMPOSE_FILE exported in the calling shell cannot leak in: set to undefined, a spawn leaves them out.
export function composeEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, COMPOSE_FILE: undefined, COMPOSE_PROJECT_NAME: undefined, ...overrides }
}

export async function composeConfig(dir: string, env: Record<string, string> = {}): Promise<ComposeConfig> {
  const result = await compose(['config', '--format', 'json'], { cwd: dir, env: composeEnv(env) })

  if (result.code !== 0)
    throw new WtError(`docker compose config failed in ${dir}:\n${result.stderr}`)

  return JSON.parse(result.stdout) as ComposeConfig
}

const COMPOSE_FILE_LINE = /^COMPOSE_FILE=(.*)$/m
const QUOTES_AROUND = /^["']|["']$/g

// COMPOSE_FILE from the worktree's .env without wt's own override (any file under `overrides`), falling back to the compose file found in dir.
export function baseComposeFiles(dir: string, overrides: string): string[] {
  const envFile = join(dir, '.env')
  const line = existsSync(envFile) ? readFileSync(envFile, 'utf8').match(COMPOSE_FILE_LINE) : null
  const files = line ? line[1]!.replace(QUOTES_AROUND, '').split(':').filter(Boolean) : []
  const base = files.filter(file => !file.startsWith(`${overrides}/`))

  if (base.length)
    return base

  const found = COMPOSE_FILES.find(file => existsSync(join(dir, file)))

  if (found === undefined)
    throw new WtError(`no compose file in ${dir}`)

  return [found]
}

const q = (value: string) => JSON.stringify(value)
const DEVPROXY_HOST_LABEL = /^devproxy\.[\w-]+\.host$/
const SERVICE = /^[^:]*/

/**
 * The devproxy labels routing the worktree's hosts, by service: each manifest route on the service it names, a dev server route on the first routed service, which only has to be running.
 * Host labels the stack's own compose file sets are rewritten to the worktree's hosts, so main's never get claimed twice.
 */
export function proxyLabels(worktree: Worktree, config: ComposeConfig): Map<string, [string, string][]> {
  const { routes, skip = [] } = worktree.project
  const labels = new Map<string, [string, string][]>()
  const add = (service: string, ...entries: [string, string][]) => labels.set(service, [...labels.get(service) ?? [], ...entries])
  const routed = routes.find(route => route.to !== 'client')?.to
  const anchor = routed === undefined ? Object.keys(config.services).find(service => !skip.includes(service)) : SERVICE.exec(routed)![0]

  for (const [index, route] of routes.entries()) {
    const key = `devproxy.wt${index}`
    const host: [string, string] = [`${key}.host`, worktreeHost(route.host, worktree.task)]

    if (route.to === 'client') {
      if (anchor !== undefined)
        add(anchor, host, [`${key}.to`, `host:${worktree.clientPort}`])

      continue
    }

    const [service = '', port = ''] = route.to.split(':')

    add(service, host, [`${key}.port`, port], ...route.passthrough ? [[`${key}.passthrough`, 'true'] as [string, string]] : [])
  }

  for (const [service, settings] of Object.entries(config.services)) {
    for (const [key, value] of Object.entries(settings.labels ?? {})) {
      if (DEVPROXY_HOST_LABEL.test(key))
        add(service, [key, value.split(',').map(host => worktreeHost(host.trim(), worktree.task)).join(',')])
    }
  }

  return labels
}

// Container names, host ports and shared-network aliases keep two copies of a stack from running side by side, so the override takes them away. Old container names come back as aliases inside the stack's own networks, where its config still dials them.
export function renderOverride(worktree: Worktree, config: ComposeConfig): string {
  const skip = new Set(worktree.project.skip)
  const routeHosts = new Set(worktree.project.routeHosts)
  const labels = proxyLabels(worktree, config)
  // The shared network devproxy serves from, the one named in its config.
  const network = worktree.project.settings.proxyNetwork
  // The proxy publishes 443 on the host, so a container reaches the worktree's own hosts through the gateway.
  const extraHosts = worktree.project.routes
    .filter(route => !route.host.startsWith('*.'))
    .map(route => `      - ${q(`${worktreeHost(route.host, worktree.task)}:host-gateway`)}`)
  const lines = [`# Generated by wt for ${worktree.id}, rewritten on every \`wt sync\`.`, 'services:']
  let joined = false

  for (const [name, service] of Object.entries(config.services)) {
    const body: string[] = []

    if (skip.has(name))
      body.push(`    profiles: [${q(SKIP_PROFILE)}]`)

    if (service.container_name !== undefined && service.container_name !== '')
      body.push('    container_name: !reset null')

    if ((service.ports?.length ?? 0) > 0)
      body.push('    ports: !reset []')

    if (routeHosts.has(name) && extraHosts.length)
      body.push('    extra_hosts:', ...extraHosts)

    if (labels.has(name))
      body.push('    labels:', ...labels.get(name)!.map(([key, value]) => `      ${q(key)}: ${q(value)}`))

    const networks = (service.network_mode ?? '') !== '' ? [] : Object.entries(service.networks ?? {})
    // devproxy dials a service it routes by container name, so one off the proxy network joins it; every other network is listed too, since a networks list in an override replaces the implicit default.
    const joins = (service.network_mode ?? '') === '' && !skip.has(name) && !(network in (service.networks ?? {})) && labels.get(name)?.some(([key]) => key.endsWith('.port')) === true
    const networkLines = networks.flatMap(([own, settings]) => {
      if (own === network)
        return (settings?.aliases?.length ?? 0) > 0 ? [`      ${network}:`, '        aliases: !reset []'] : []

      if (service.container_name !== undefined && service.container_name !== '')
        return [`      ${q(own)}:`, `        aliases: [${q(service.container_name)}]`]

      return joins ? [`      ${q(own)}: {}`] : []
    })

    if (joins) {
      joined = true
      networkLines.push(`      ${network}: {}`)
    }

    if (networkLines.length)
      body.push('    networks:', ...networkLines)

    if (body.length)
      lines.push(`  ${q(name)}:`, ...body)
  }

  if (joined && config.networks?.[network] === undefined)
    lines.push('networks:', `  ${network}:`, `    name: ${network}`, '    external: true')

  return `${lines.join('\n')}\n`
}

// Things the override cannot make safe, reported rather than silently shared with main.
export function overrideWarnings(worktree: Worktree, config: ComposeConfig): string[] {
  const skip = new Set(worktree.project.skip)
  const network = worktree.project.settings.proxyNetwork
  const warnings: string[] = []

  for (const [name, service] of Object.entries(config.services)) {
    if (skip.has(name))
      continue

    if (service.network_mode === 'host')
      warnings.push(`service ${name} runs on the host network and may collide with main, consider adding it to skip`)

    // Compose aliases a service under its own name on every network it joins, and `aliases: !reset []` cannot take that one away: on the shared network the worktree answers to it alongside main. Only an alias main keeps to itself leaves the two of them apart.
    if (service.networks && network in service.networks && !service.networks[network]?.aliases?.some(alias => alias !== name))
      warnings.push(`service ${name} has no alias of its own on the proxy network, so the worktree answers to ${name} there too and the shared proxy round-robins between them, give it one in the project override`)
  }

  for (const [key, volume] of Object.entries(config.volumes ?? {})) {
    if (volume.external || (volume.name !== undefined && !volume.name.startsWith(`${config.name}_`)))
      warnings.push(`volume ${key} is named ${volume.name ?? key} outside the project, main and the worktree share it`)
  }

  return warnings
}

/** The manifest's service names compose does not know, each a setting that would quietly do nothing (or fail `wt run`). */
export function unknownServices(project: Project, config: ComposeConfig): string[] {
  const named: [setting: string, names: string[]][] = [
    ['skip', project.skip ?? []],
    ['routeHosts', project.routeHosts ?? []],
    ['routes', project.routes.filter(route => route.to !== 'client').map(route => SERVICE.exec(route.to)![0])],
    ['run.service', project.run ? [project.run.service] : []],
  ]

  return named.flatMap(([setting, names]) => [...new Set(names)]
    .filter(name => config.services[name] === undefined)
    .map(name => `${project.name}: ${setting} names ${name}, which is not a service of ${config.name}`))
}

/** The compose projects with containers, running ones only unless `all`. */
export async function runningProjects(all = false): Promise<Set<string>> {
  const result = await compose(['ls', ...all ? ['-a'] : [], '--format', 'json'])

  if (result.code !== 0)
    return new Set()

  return new Set((JSON.parse(result.stdout) as { Name: string }[]).map(stack => stack.Name))
}
