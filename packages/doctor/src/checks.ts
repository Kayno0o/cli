import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { completionDir, missingCompletions } from './completions'

export interface Result {
  check: string
  ok: boolean
  detail: string
  // The command that resolves a failure.
  fix?: string
}

export interface Host {
  home: string
  // Where `bun install -g` puts the packages.
  globalModules: string
  bunVersion: string
  which: (bin: string) => string | null
  // `env` adds to the environment the command inherits.
  run: (argv: string[], env?: Record<string, string>) => Promise<{ code: number, stdout: string, stderr: string }>
}

// Every @kaynooo/cli-* package and the bins it installs; the repo's tests check it against packages/*.
export const TOOLS: Record<string, string[]> = {
  '@kaynooo/cli-base': ['base', 'proof'],
  '@kaynooo/cli-changelog': ['changelog'],
  '@kaynooo/cli-check': ['check', 'fix', 'errs'],
  '@kaynooo/cli-code': ['peek', 'todo-scan', 'hotspots'],
  '@kaynooo/cli-db': ['db'],
  '@kaynooo/cli-docker': ['dc', 'dx'],
  '@kaynooo/cli-doctor': ['doctor', 'cli'],
  '@kaynooo/cli-edit': ['sub'],
  '@kaynooo/cli-env': ['ev', 'redact'],
  '@kaynooo/cli-forgejo': ['ft'],
  '@kaynooo/cli-git': ['gst', 'gc'],
  '@kaynooo/cli-gitlab': ['gl'],
  '@kaynooo/cli-guard': ['guard'],
  '@kaynooo/cli-out': ['out'],
  '@kaynooo/cli-dev': ['dev'],
  '@kaynooo/cli-pick': ['pick'],
  '@kaynooo/cli-pkg': ['pkg'],
  '@kaynooo/cli-probe': ['probe'],
  '@kaynooo/cli-repos': ['repos'],
  '@kaynooo/cli-stack': ['stack'],
  '@kaynooo/cli-sweep': ['sweep'],
  '@kaynooo/cli-view': ['view'],
  '@kaynooo/cli-wait': ['waitfor', 'slot'],
}

export const FORGE = 'git.kaynooo.fr'
// The same Forgejo under the private name its owner's network reaches it by, which a login may use instead.
const FORGE_HOSTS = new Set([FORGE, 'git.kaynooo.fr'])
const PLUGIN = 'cli-hooks@kaynooo-cli'
const MARKETPLACE = `https://${FORGE}/kaynooo/cli.git`
const LEADING_TILDE = /^~(?=\/|$)/

interface Manifest { version?: string, engines?: { bun?: string }, bin?: Record<string, string> | string }

const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
// `bun info` calls in flight at once, so the registry is not asked for every package together.
const INFO_AT_ONCE = 4

export function readJsonText<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  }
  catch {
    return undefined
  }
}

function readJson<T>(path: string): T | undefined {
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

// The file the installed package declares for the bin, undefined when it declares none, so the one under test is run and not the first of that name on the PATH.
export function ownBin(host: Host, name: string, bin: string): string | undefined {
  const declared = installed(host, name)?.bin
  const file = typeof declared === 'string' ? declared : declared?.[bin]

  return file === undefined ? undefined : join(host.globalModules, name, file)
}

// One package: installed, its bins on the PATH, and no older than the version the registry serves.
export async function checkTool(host: Host, name: string, bins: readonly string[]): Promise<Result> {
  const check = name.slice(name.indexOf('/') + 1)
  const version = installed(host, name)?.version

  if (version === undefined)
    return { check, ok: false, detail: 'not installed', fix: `bun install -g ${name}` }

  const off = bins.filter(bin => host.which(bin) === null)

  if (off.length > 0)
    return { check, ok: false, detail: `${version}, ${off.join(', ')} not on the PATH`, fix: `add ${join(host.globalModules, '..', '..', '..', 'bin')} to the PATH` }

  const info = await host.run(['bun', 'info', name, 'version', '--no-cache'])
  const answered = info.code === 0 ? firstLine(info.stdout.trim().split('\n').at(-1) ?? '') : ''
  const latest = VERSION.test(answered) ? answered : ''

  if (latest === '')
    return { check, ok: true, detail: `${version}, the registry did not answer: ${firstLine(info.stderr) || answered || 'no version'}` }

  if (Bun.semver.order(version, latest) < 0)
    return { check, ok: false, detail: `${version}, ${latest} released`, fix: `bun install -g ${name}@${latest}` }

  return { check, ok: true, detail: version }
}

// tea installed, logged in to the forge and reaching it, since ft goes through it.
export async function checkTea(host: Host): Promise<Result> {
  if (host.which('tea') === null)
    return { check: 'tea', ok: false, detail: 'not installed, and ft goes through it', fix: 'install tea from https://gitea.com/gitea/tea/releases' }

  const logins = await host.run(['tea', 'login', 'list', '-o', 'json'])
  const parsed = logins.code === 0 ? readJsonText<{ name: string, url: string }[]>(logins.stdout) : undefined
  const login = parsed?.find(each => URL.canParse(each.url) && FORGE_HOSTS.has(new URL(each.url).host))

  if (login === undefined)
    return { check: 'tea', ok: false, detail: `no login to ${FORGE}`, fix: `tea login add --url https://${FORGE} --oauth` }

  const version = await host.run(['tea', 'api', '--login', login.name, 'version'])
  const served = version.code === 0 ? readJsonText<{ version?: string }>(version.stdout)?.version : undefined

  const forge = new URL(login.url).host

  if (served === undefined)
    return { check: 'tea', ok: false, detail: `${forge} did not answer: ${firstLine(version.stderr || version.stdout)}`, fix: `tea login edit ${login.name} --token <token>, or check the network` }

  return { check: 'tea', ok: true, detail: `logged in to ${forge} as ${login.name}, Forgejo ${served}` }
}

// The hooks wired one way exactly: the cli-hooks plugin or the dotfiles' cli mod, never both.
export function checkHooks(host: Host): Result {
  const settings = readJson<{ enabledPlugins?: Record<string, boolean>, env?: Record<string, string> }>(join(host.home, '.claude', 'settings.json')) ?? {}
  const plugin = settings.enabledPlugins?.[PLUGIN] === true
  const mod = (settings.env?.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(':').map(dir => dir.replace(LEADING_TILDE, host.home)).find(dir => basename(dir) === 'cli' && existsSync(join(dir, 'hooks', 'hooks.json')))

  if (plugin && mod !== undefined)
    return { check: 'hooks', ok: false, detail: `both the ${PLUGIN} plugin and the mod in ${mod} run guard, so every call is checked twice`, fix: `claude plugin disable ${PLUGIN}` }

  if (plugin)
    return { check: 'hooks', ok: true, detail: `the ${PLUGIN} plugin` }

  if (mod !== undefined)
    return { check: 'hooks', ok: true, detail: `the cli mod in ${mod}` }

  return { check: 'hooks', ok: false, detail: 'neither the plugin nor the cli mod is wired into ~/.claude/settings.json', fix: `claude plugin install cli-hooks --marketplace ${MARKETPLACE}` }
}

// Bun at least as new as every installed package asks for.
export function checkBun(host: Host): Result {
  const floors = Object.keys(TOOLS).flatMap(name => installed(host, name)?.engines?.bun ?? [])
  const unmet = floors.filter(range => !Bun.semver.satisfies(host.bunVersion, range))

  if (unmet.length > 0)
    return { check: 'bun', ok: false, detail: `${host.bunVersion}, the tools ask for ${[...new Set(unmet)].join(' and ')}`, fix: 'bun upgrade' }

  return { check: 'bun', ok: true, detail: floors.length === 0 ? host.bunVersion : `${host.bunVersion}, the tools ask for ${[...new Set(floors)].join(' and ')}` }
}

// Fish completes every installed bin, when fish is installed.
export function checkCompletions(host: Host): Result {
  if (host.which('fish') === null)
    return { check: 'completions', ok: true, detail: 'fish is not installed' }

  const dir = completionDir(host.home)
  const missing = missingCompletions(host, dir)

  if (missing.length > 0)
    return { check: 'completions', ok: false, detail: `no fish completion in ${dir} for ${missing.join(', ')}`, fix: 'cli completions fish --install' }

  return { check: 'completions', ok: true, detail: dir }
}

export async function runChecks(host: Host): Promise<Result[]> {
  const entries = Object.entries(TOOLS)
  const tools: Result[] = []

  for (let at = 0; at < entries.length; at += INFO_AT_ONCE)
    tools.push(...await Promise.all(entries.slice(at, at + INFO_AT_ONCE).map(async ([name, bins]) => checkTool(host, name, bins))))

  return [...tools, await checkTea(host), checkHooks(host), checkBun(host), checkCompletions(host)]
}
