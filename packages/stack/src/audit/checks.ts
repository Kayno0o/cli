import type { ComposeModel, ComposeService, EnvRef, Finding, Release, ReleaseConfig } from './types'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ENV_REF = /\$\{([A-Z_]\w*)(\s*:?[-?][^}]*)?\}/gi
const YAML_FILE = /\.ya?ml$/
const LEADING_DOT_SLASH = /^\.\//
const SERVICES_KEY = /^services:/m
const EXEC_SERVICE = /\{compose\}(?:\s+--\S+)*\s+(?:exec|run)\s+(?:-\S+\s+)*([\w-]+)/

export interface Layout {
  root: string
  config: ReleaseConfig
  releases: Release[]
  composeFiles: string[]
  base: string | undefined
  overlays: string[]
  model: ComposeModel | undefined
}

const services = (model: ComposeModel | undefined): [string, ComposeService][] => Object.entries(model?.services ?? {})

// Text up to the first separator, or all of it.
function before(text: string, separator: string): string {
  const at = text.indexOf(separator)

  return at < 0 ? text : text.slice(0, at)
}

export const stripDotSlash = (file: string) => file.replace(LEADING_DOT_SLASH, '')

// The compose files that exist among deploySyncFiles, the shortest name being the base the others overlay.
export function composeLayout(root: string, config: ReleaseConfig): Pick<Layout, 'composeFiles' | 'base' | 'overlays'> {
  const composeFiles = (config.deploySyncFiles ?? []).map(stripDotSlash).filter(file => YAML_FILE.test(file) && existsSync(join(root, file)))
  const [base] = composeFiles.toSorted((a, b) => a.length - b.length)

  return { composeFiles, base, overlays: composeFiles.filter(file => file !== base) }
}

export function syncFindings(root: string, config: ReleaseConfig): Finding[] {
  return (config.deploySyncFiles ?? [])
    .filter(file => !existsSync(join(root, stripDotSlash(file))))
    .map(file => ({ level: 'error', check: 'sync', message: `deploySyncFiles entry does not exist: ${file}` }))
}

export function buildFindings(root: string, releases: Release[], env: Record<string, string | undefined>, home: string): Finding[] {
  const findings: Finding[] = []
  const missing = (release: Release, key: 'sourceDir' | 'buildContext' | 'dockerfile') => {
    const path = release[key]

    if (path !== undefined && path !== '' && !existsSync(join(root, path)))
      findings.push({ level: 'error', check: 'build', message: `${release.slug}: ${key} does not exist: ${path}` })
  }

  for (const release of releases) {
    missing(release, 'sourceDir')
    missing(release, 'buildContext')
    missing(release, 'dockerfile')

    for (const secret of release.buildSecrets ?? []) {
      if (secret.src !== undefined && secret.src !== '') {
        const path = secret.src.startsWith('~') ? join(home, secret.src.slice(1)) : resolve(root, secret.src)

        if (!existsSync(path))
          findings.push({ level: 'error', check: 'build', message: `${release.slug}: buildSecret "${secret.id}" src does not exist: ${secret.src}` })
      }

      if (secret.env !== undefined && secret.env !== '' && (env[secret.env] ?? '') === '')
        findings.push({ level: 'warn', check: 'build', message: `${release.slug}: buildSecret "${secret.id}" reads $${secret.env}, unset in this shell` })
    }
  }

  return findings
}

export function envRefs(root: string, composeFiles: string[]): EnvRef[] {
  return composeFiles.flatMap(file => [...readFileSync(join(root, file), 'utf8').matchAll(ENV_REF)].map(match => ({ name: match[1] as string, defaulted: Boolean(match[2]), file })))
}

// An empty requiredServerEnv means the project never adopted the preflight check, a partial one means a key drifted out of it. Only the second is a regression.
export function envFindings(refs: EnvRef[], required: string[]): Finding[] {
  const findings: Finding[] = []
  const level = required.length > 0 ? 'error' : 'warn'

  for (const name of new Set(refs.filter(ref => !ref.defaulted).map(ref => ref.name))) {
    if (!name.endsWith('_VERSION') && !required.includes(name))
      findings.push({ level, check: 'env', message: `\${${name}} has no default in ${refs.find(ref => ref.name === name)?.file} and is not in requiredServerEnv` })
  }

  for (const name of required) {
    if (!refs.some(ref => ref.name === name))
      findings.push({ level: 'warn', check: 'env', message: `requiredServerEnv lists ${name}, which no compose file references` })
  }

  return findings
}

export function versionFindings(refs: EnvRef[], releases: Release[]): Finding[] {
  const findings: Finding[] = []
  const inCompose = new Set(refs.filter(ref => ref.name.endsWith('_VERSION')).map(ref => ref.name))
  const inConfig = new Set(releases.map(release => release.versionEnv).filter((name): name is string => typeof name === 'string' && name !== ''))

  for (const name of inConfig) {
    if (!inCompose.has(name))
      findings.push({ level: 'error', check: 'version', message: `versionEnv ${name} is never interpolated by a compose file` })
  }

  for (const name of inCompose) {
    if (!inConfig.has(name))
      findings.push({ level: 'error', check: 'version', message: `compose interpolates \${${name}}, which no release declares as versionEnv` })
  }

  return findings
}

export function imageFindings(config: ReleaseConfig, releases: Release[], model: ComposeModel | undefined): Finding[] {
  const registry = config.registry ?? ''
  const declared = new Set(releases.filter(release => release.image !== undefined && release.image !== '').map(release => `${registry}/${release.image}`))
  const findings: Finding[] = []

  for (const [name, service] of services(model)) {
    const repo = service.image === undefined ? undefined : before(service.image, ':')

    if (repo !== undefined && repo.startsWith(registry) && !declared.has(repo))
      findings.push({ level: 'warn', check: 'image', message: `service "${name}" pulls ${repo}, which no release in this config builds` })
  }

  return findings
}

export function restartFindings(config: ReleaseConfig, releases: Release[], model: ComposeModel | undefined, base: string | undefined): Finding[] {
  const known = new Set(Object.keys(model?.services ?? {}))
  const findings: Finding[] = []

  for (const release of releases) {
    for (const service of release.restartServices ?? []) {
      if (!known.has(service))
        findings.push({ level: 'error', check: 'restart', message: `${release.slug}: restartServices names "${service}", absent from ${base}` })
    }
  }

  for (const server of config.servers ?? []) {
    for (const [slug, override] of Object.entries(server.releaseOverrides ?? {})) {
      for (const service of override.restartServices ?? []) {
        if (!known.has(service))
          findings.push({ level: 'error', check: 'restart', message: `server ${server.name}: releaseOverrides.${slug} names service "${service}", absent from ${base}` })
      }
    }
  }

  return findings
}

export function postDeployFindings(releases: Release[], model: ComposeModel | undefined, base: string | undefined): Finding[] {
  const known = new Set(Object.keys(model?.services ?? {}))
  const findings: Finding[] = []

  for (const release of releases) {
    for (const command of release.postDeployCommands ?? []) {
      const target = EXEC_SERVICE.exec(command)?.[1]

      if (target !== undefined && !known.has(target))
        findings.push({ level: 'warn', check: 'post-deploy', message: `${release.slug}: post-deploy command targets service "${target}", absent from ${base}` })
    }
  }

  return findings
}

// The services a release restarts, which `up --wait` gates on their healthcheck.
export const gatedServices = (releases: Release[]) => new Set(releases.flatMap(release => release.restartServices ?? []))

export function healthFindings(gated: Set<string>, model: ComposeModel | undefined): Finding[] {
  return [...gated]
    .filter((name) => {
      const service = model?.services?.[name]

      return service !== undefined && (service.healthcheck === undefined || service.healthcheck === null)
    })
    .map(name => ({ level: 'warn', check: 'health', message: `service "${name}" is restarted by a release but declares no healthcheck, so --wait will not gate it` }))
}

// Only app services: infrastructure the stack owns (its own traefik, a db exposing a loopback admin port) publishes from the base file by design.
export function routingFindings(config: ReleaseConfig, gated: Set<string>, model: ComposeModel | undefined, base: string | undefined, overlays: string[]): Finding[] {
  if (overlays.length === 0)
    return []

  const findings: Finding[] = []

  for (const name of gated) {
    const service = model?.services?.[name]

    if (service === undefined)
      continue

    if (service.ports !== undefined && service.ports.length > 0)
      findings.push({ level: 'error', check: 'routing', message: `service "${name}" publishes ports in ${base}; publishing belongs in an overlay` })

    if (Object.keys(service.labels ?? {}).some(key => key.startsWith('traefik.')))
      findings.push({ level: 'error', check: 'routing', message: `service "${name}" carries traefik labels in ${base}; routing belongs in an overlay` })
  }

  const composeArgs = config.composeArgs ?? []

  if (composeArgs.length > 0)
    findings.push({ level: 'error', check: 'routing', message: `composeArgs is set (${composeArgs.join(' ')}) while ${overlays.length} overlay(s) exist: -f overrides each server's COMPOSE_FILE and drops them` })

  for (const server of config.servers ?? []) {
    if (server.composeArgs !== undefined && server.composeArgs.length > 0)
      findings.push({ level: 'warn', check: 'routing', message: `server ${server.name} sets composeArgs; prefer its own COMPOSE_FILE` })
  }

  return findings
}

export function layoutFindings(root: string, base: string | undefined, model: ComposeModel | undefined): Finding[] {
  if (base === undefined)
    return []

  const header = readFileSync(join(root, base), 'utf8').split(SERVICES_KEY)[0] ?? ''
  const findings: Finding[] = []

  for (const [name, service] of services(model)) {
    for (const volume of service.volumes ?? []) {
      const source = typeof volume === 'string' ? before(volume, ':') : volume.source

      if (source?.startsWith('.') === true && !header.includes(stripDotSlash(source)))
        findings.push({ level: 'warn', check: 'layout', message: `service "${name}" bind-mounts ${source}, absent from the header's expected server layout` })
    }
  }

  return findings
}

export function gitignoreFindings(root: string): Finding[] {
  const path = join(root, '.gitignore')
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''

  return ['.release-logs', '.release-worktrees']
    .filter(entry => !text.includes(entry))
    .map(entry => ({ level: 'warn', check: 'gitignore', message: `${entry}/ is not in .gitignore` }))
}
