import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { configuredNumber } from '@kaynooo/cli-kit'
import { NEEDS, TOOLS } from './catalog'

export { TOOLS }

export type FixAction = { kind: 'install', spec: string } | { kind: 'run', argv: string[] }

export interface Result {
  check: string
  ok: boolean
  // True when the check did not fail (exit 0) but could not verify (e.g. offline or unreachable registry).
  warn?: boolean
  detail: string
  // The command that resolves a failure.
  fix?: string
  // Structured runnable action for `--fix`, avoiding regex parsing of `fix`.
  fixAction?: FixAction
  // What `--fix` runs for a fix that is no single command.
  apply?: (host: Host) => Promise<string | undefined>
}

export interface Host {
  home: string
  // Where `bun install -g` puts the packages.
  globalModules: string
  bunVersion: string
  // The login shell's name, from the password database or else $SHELL, '' when neither has one.
  shell: string
  which: (bin: string) => string | null
  // `env` adds to the environment the command inherits.
  run: (argv: string[], env?: Record<string, string>) => Promise<{ code: number, stdout: string, stderr: string }>
}

interface Manifest { version?: string, engines?: { bun?: string }, bin?: Record<string, string> | string }

export const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
// `bun info` calls in flight at once, so the registry is not asked for every package together.
export const INFO_AT_ONCE = configuredNumber('doctor', 'concurrency', 4)
export const NETWORK_ERROR = /DNSResolveFailed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|Unable to connect|timed out/i

export function readJsonText<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  }
  catch {
    return undefined
  }
}

export function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? readJsonText<T>(readFileSync(path, 'utf8')) : undefined
}

export function firstLine(text: string): string {
  const trimmed = text.trim()
  const end = trimmed.indexOf('\n')

  return end === -1 ? trimmed : trimmed.slice(0, end)
}

function installed(host: Host, name: string): Manifest | undefined {
  return readJson<Manifest>(join(host.globalModules, name, 'package.json'))
}

export function isInstalled(host: Host, name: string): boolean {
  return installed(host, name)?.version !== undefined
}

// The file the installed package declares for the bin, undefined when it declares none, so the one under test is run and not the first of that name on the PATH.
export function ownBin(host: Host, name: string, bin: string): string | undefined {
  const declared = installed(host, name)?.bin
  const file = typeof declared === 'string' ? declared : declared?.[bin]

  return file === undefined ? undefined : join(host.globalModules, name, file)
}

// The folder `bun install -g` links the bins into.
export function binDir(host: Host): string {
  return join(host.globalModules, '..', '..', '..', 'bin')
}

// One package: installed, its bins on the PATH, and no older than the version the registry serves.
export async function checkTool(host: Host, name: string, bins: readonly string[], { offline = false, registryDown }: { offline?: boolean, registryDown?: string } = {}): Promise<Result> {
  const check = name.slice(name.indexOf('/') + 1)
  const version = installed(host, name)?.version

  if (version === undefined)
    return { check, ok: false, detail: 'not installed', fix: `bun install -g ${name}`, fixAction: { kind: 'install', spec: name } }

  const off = bins.filter(bin => host.which(bin) === null)

  if (offline || registryDown !== undefined) {
    if (off.length > 0)
      return { check, ok: false, detail: `${version}, ${off.join(', ')} not on the PATH`, fix: `add ${binDir(host)} to the PATH` }

    return { check, ok: true, warn: true, detail: offline ? `${version}, skipped (--offline)` : `${version}, the registry did not answer: ${registryDown}` }
  }

  const info = await host.run(['bun', 'info', name, 'version', '--no-cache'])
  const answered = info.code === 0 ? firstLine(info.stdout.trim().split('\n').at(-1) ?? '') : ''
  const latest = VERSION.test(answered) ? answered : ''

  // A release newer than the install comes first: an old version often lacks the very bin that is missing.
  if (latest !== '' && Bun.semver.order(version, latest) < 0)
    return { check, ok: false, detail: `${version}, ${latest} released${off.length > 0 ? `, ${off.join(', ')} not on the PATH` : ''}`, fix: `bun install -g ${name}@${latest}`, fixAction: { kind: 'install', spec: `${name}@${latest}` } }

  if (off.length > 0)
    return { check, ok: false, detail: `${version}, ${off.join(', ')} not on the PATH`, fix: `add ${binDir(host)} to the PATH` }

  if (latest === '')
    return { check, ok: true, warn: true, detail: `${version}, the registry did not answer: ${firstLine(info.stderr) || answered || 'no version'}` }

  return { check, ok: true, detail: version }
}

// Bun at least as new as every installed package asks for.
export function checkBun(host: Host): Result {
  const floors = Object.keys(TOOLS).flatMap(name => installed(host, name)?.engines?.bun ?? [])
  const unmet = floors.filter(range => !Bun.semver.satisfies(host.bunVersion, range))

  if (unmet.length > 0)
    return { check: 'bun', ok: false, detail: `${host.bunVersion}, the tools ask for ${[...new Set(unmet)].join(' and ')}`, fix: 'bun upgrade' }

  return { check: 'bun', ok: true, detail: floors.length === 0 ? host.bunVersion : `${host.bunVersion}, the tools ask for ${[...new Set(floors)].join(' and ')}` }
}

// The links in the bin folder pointing at a file of ours that is gone: `bun install -g` leaves the bins a newer version dropped.
export function deadBins(host: Host): string[] {
  const dir = binDir(host)
  const ours = join(host.globalModules, '@kaynooo')
  let names: string[] = []

  try {
    names = readdirSync(dir)
  }
  catch {
    return []
  }

  return names.filter((name) => {
    const path = join(dir, name)

    try {
      return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true && resolve(dir, readlinkSync(path)).startsWith(`${ours}/`) && !existsSync(path)
    }
    catch {
      return false
    }
  }).sort()
}

export function checkDeadBins(host: Host): Result {
  const dead = deadBins(host)

  if (dead.length === 0)
    return { check: 'dead-bins', ok: true, detail: `no link in ${binDir(host)} points at a removed bin` }

  return {
    check: 'dead-bins',
    ok: false,
    detail: `${dead.join(', ')} in ${binDir(host)} point at bins the installed versions dropped`,
    fix: `rm ${dead.map(name => join(binDir(host), name)).join(' ')}`,
    apply: async (on) => {
      await Promise.all(deadBins(on).map(async name => rm(join(binDir(on), name))))

      return undefined
    },
  }
}

// The system tools the installed packages need, besides tea: a missing one fails unless its alternative is installed.
export function checkNeeds(host: Host): Result {
  const missing = Object.entries(NEEDS).flatMap(([name, needs]) => isInstalled(host, name)
    ? needs.filter(need => need.bin !== 'tea' && host.which(need.bin) === null && (need.alternative === undefined || host.which(need.alternative) === null))
    : [])

  if (missing.length > 0)
    return { check: 'needs', ok: false, detail: `missing ${missing.map(need => `${need.bin} (${need.why})`).join(', ')}`, fix: `install ${missing.map(need => `${need.bin}: ${need.how}`).join('; ')}` }

  return { check: 'needs', ok: true, detail: 'every tool the installed packages need is on the PATH' }
}
