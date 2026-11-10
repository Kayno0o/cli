import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { configuredNumber, userConfigReadPath, workspaceRoot } from '@kaynooo/cli-kit'
import { HOOKS_REQUIRES, NEEDS } from './catalog'
import { completionDir, missingCompletions } from './completions'

export interface Result {
  check: string
  ok: boolean
  detail: string
  // The command that resolves a failure.
  fix?: string
  // What `--fix` runs for a fix that is no single command.
  apply?: (host: Host) => Promise<string | undefined>
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
  '@kaynooo/cli-arc': ['arc'],
  '@kaynooo/cli-base': ['base', 'proof'],
  '@kaynooo/cli-changelog': ['changelog'],
  '@kaynooo/cli-check': ['check', 'fix', 'errs', 'j'],
  '@kaynooo/cli-code': ['src', 'peek', 'todo-scan', 'hotspots'],
  '@kaynooo/cli-db': ['db'],
  '@kaynooo/cli-docker': ['dc', 'dlog', 'dx', 'sf'],
  '@kaynooo/cli-doctor': ['doctor', 'cli'],
  '@kaynooo/cli-edit': ['sub'],
  '@kaynooo/cli-env': ['ev', 'redact'],
  '@kaynooo/cli-forgejo': ['ft'],
  '@kaynooo/cli-git': ['gst', 'gc', 'gb', 'gp', 'gf', 'gm', 'gcl', 'gd', 'gu'],
  '@kaynooo/cli-gitlab': ['gl'],
  '@kaynooo/cli-gloss': ['gloss'],
  '@kaynooo/cli-guard': ['guard'],
  '@kaynooo/cli-out': ['out'],
  '@kaynooo/cli-dev': ['dev'],
  '@kaynooo/cli-dl': ['dl'],
  '@kaynooo/cli-pick': ['pick'],
  '@kaynooo/cli-pkg': ['pkg'],
  '@kaynooo/cli-probe': ['probe'],
  '@kaynooo/cli-proc': ['proc', 'pid', 'ports', 'procs'],

  '@kaynooo/cli-stack': ['stack'],
  '@kaynooo/cli-view': ['view'],
  '@kaynooo/cli-wait': ['waitfor', 'slot'],
  '@kaynooo/cli-workspace': ['ws', 'repos', 'sweep', 'audit'],
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
const INFO_AT_ONCE = configuredNumber('doctor', 'concurrency', 4)

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

export function isInstalled(host: Host, name: string): boolean {
  return installed(host, name)?.version !== undefined
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
  const info = await host.run(['bun', 'info', name, 'version', '--no-cache'])
  const answered = info.code === 0 ? firstLine(info.stdout.trim().split('\n').at(-1) ?? '') : ''
  const latest = VERSION.test(answered) ? answered : ''

  // A release newer than the install comes first: an old version often lacks the very bin that is missing.
  if (latest !== '' && Bun.semver.order(version, latest) < 0)
    return { check, ok: false, detail: `${version}, ${latest} released${off.length > 0 ? `, ${off.join(', ')} not on the PATH` : ''}`, fix: `bun install -g ${name}@${latest}` }

  if (off.length > 0)
    return { check, ok: false, detail: `${version}, ${off.join(', ')} not on the PATH`, fix: `add ${join(host.globalModules, '..', '..', '..', 'bin')} to the PATH` }

  if (latest === '')
    return { check, ok: true, detail: `${version}, the registry did not answer: ${firstLine(info.stderr) || answered || 'no version'}` }

  return { check, ok: true, detail: version }
}

// Other hosts the same forge answers on, from `forgeHosts` in ~/.config/kaynooo-cli/doctor.json.
function extraForgeHosts(home: string): string[] {
  try {
    const path = userConfigReadPath('doctor', [], { home, xdg: process.env.XDG_CONFIG_HOME })

    if (!existsSync(path))
      return []

    const raw = Bun.JSONC.parse(readFileSync(path, 'utf8')) as { forgeHosts?: unknown } | null

    return Array.isArray(raw?.forgeHosts) ? raw.forgeHosts.filter((each): each is string => typeof each === 'string') : []
  }
  catch {
    return []
  }
}

const TEA_URL = /^\s*url:\s*["']?([^\s"']+)/m
const TEA_TOKEN = /^\s*token:\s*["']?([^\s"']+)/m

// gt standing in for tea: it answers with its own login, else with the token ft passes it from tea's config.
async function checkGt(host: Host): Promise<Result> {
  const own = await host.run(['gt', 'api', 'version'])
  const ownServed = own.code === 0 ? readJsonText<{ version?: string }>(own.stdout)?.version : undefined

  if (ownServed !== undefined)
    return { check: 'tea', ok: true, detail: `tea is not installed; gt reaches Forgejo ${ownServed} with its own login` }

  const path = join(host.home, '.config', 'tea', 'config.yml')
  const config = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const url = TEA_URL.exec(config)?.[1]
  const token = TEA_TOKEN.exec(config)?.[1]

  if (url === undefined || token === undefined)
    return { check: 'tea', ok: false, detail: `tea is not installed and gt has no login: ${firstLine(own.stderr || own.stdout)}`, fix: `gt auth login --host https://${FORGE}` }

  const injected = await host.run(['gt', 'api', 'version'], { GITEA_TOKEN: token, GITEA_CLI_HOST: url })
  const served = injected.code === 0 ? readJsonText<{ version?: string }>(injected.stdout)?.version : undefined

  if (served === undefined)
    return { check: 'tea', ok: false, detail: `gt did not reach ${new URL(url).host} with tea's token: ${firstLine(injected.stderr || injected.stdout)}`, fix: `gt auth login --host ${url}` }

  return { check: 'tea', ok: true, detail: `tea is not installed; gt reaches ${new URL(url).host} with tea's token, Forgejo ${served}` }
}

// tea installed, logged in to the forge and reaching it, since ft goes through it.
export async function checkTea(host: Host): Promise<Result> {
  if (host.which('tea') === null && host.which('gt') !== null)
    return checkGt(host)

  if (host.which('tea') === null)
    return { check: 'tea', ok: false, detail: 'not installed, and ft goes through it', fix: 'install tea from https://gitea.com/gitea/tea/releases, or gt (gitea-cli)' }

  const logins = await host.run(['tea', 'login', 'list', '-o', 'json'])
  const parsed = logins.code === 0 ? readJsonText<{ name: string, url: string }[]>(logins.stdout) : undefined
  const hosts = new Set([...FORGE_HOSTS, ...extraForgeHosts(host.home)])
  const login = parsed?.find(each => URL.canParse(each.url) && hosts.has(new URL(each.url).host))

  if (login === undefined)
    return { check: 'tea', ok: false, detail: `no login to ${FORGE}`, fix: `tea login add --url https://${FORGE} --oauth` }

  const version = await host.run(['tea', 'api', '--login', login.name, 'version'])
  const served = version.code === 0 ? readJsonText<{ version?: string }>(version.stdout)?.version : undefined

  const forge = new URL(login.url).host

  if (served === undefined)
    return { check: 'tea', ok: false, detail: `${forge} did not answer: ${firstLine(version.stderr || version.stdout)}`, fix: `tea login edit ${login.name} --token <token>, or check the network` }

  return { check: 'tea', ok: true, detail: `logged in to ${forge} as ${login.name}, Forgejo ${served}` }
}

// How the hooks are wired: the cli-hooks plugin, the dotfiles' cli mod (the folder holding it), both or neither.
export function hooksWiring(host: Host): { plugin: boolean, mod: string | undefined } {
  const settings = readJson<{ enabledPlugins?: Record<string, boolean>, env?: Record<string, string> }>(join(host.home, '.claude', 'settings.json')) ?? {}
  const plugin = settings.enabledPlugins?.[PLUGIN] === true
  const mod = (settings.env?.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(':').map(dir => dir.replace(LEADING_TILDE, host.home)).find(dir => basename(dir) === 'cli' && existsSync(join(dir, 'hooks', 'hooks.json')))

  return { plugin, mod }
}

// The hooks wired one way exactly: the cli-hooks plugin or the dotfiles' cli mod, never both, and the guard they call installed.
export function checkHooks(host: Host): Result {
  const { plugin, mod } = hooksWiring(host)

  if ((plugin || mod !== undefined) && !isInstalled(host, HOOKS_REQUIRES))
    return { check: 'hooks', ok: false, detail: `wired, but ${HOOKS_REQUIRES} is not installed, so every hook finds no guard`, fix: `bun install -g ${HOOKS_REQUIRES}` }

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

// The system tools the installed packages need, besides tea: a missing one fails.
export function checkNeeds(host: Host): Result {
  const missing = Object.entries(NEEDS).flatMap(([name, needs]) => isInstalled(host, name) ? needs.filter(need => need.bin !== 'tea' && host.which(need.bin) === null) : [])

  if (missing.length > 0)
    return { check: 'needs', ok: false, detail: `missing ${missing.map(need => `${need.bin} (${need.why})`).join(', ')}`, fix: `install ${missing.map(need => `${need.bin}: ${need.how}`).join('; ')}` }

  return { check: 'needs', ok: true, detail: 'every tool the installed packages need is on the PATH' }
}

const WAKATIME_RELEASE = 'https://api.github.com/repos/wakatime/wakatime-cli/releases/latest'
const WAKATIME_ARCH: Record<string, string> = { x64: 'amd64', arm64: 'arm64' }
const LEADING_V = /^v/

// Downloads the linux release into ~/.wakatime and points the `wakatime-cli` symlink at it, the layout every official plugin uses; an error message, undefined on success.
async function installWakatime(host: Host, tag: string, arch: string): Promise<string | undefined> {
  const folder = join(host.home, '.wakatime')
  const name = `wakatime-cli-linux-${arch}`
  const zip = join(folder, `${name}.zip`)

  mkdirSync(folder, { recursive: true })

  const steps = [
    ['curl', '-fsSL', '-o', zip, `https://github.com/wakatime/wakatime-cli/releases/download/${tag}/${name}.zip`],
    ['unzip', '-o', '-d', folder, zip],
    ['chmod', '+x', join(folder, name)],
    ['ln', '-sfn', join(folder, name), join(folder, 'wakatime-cli')],
  ]

  for (const argv of steps) {
    const ran = await host.run(argv)

    if (ran.code !== 0)
      return `${argv[0]} exit ${ran.code}: ${firstLine(ran.stderr || ran.stdout)}`
  }

  rmSync(zip, { force: true })

  return undefined
}

// ~/.wakatime/wakatime-cli there and no older than the latest wakatime-cli release; left out on a host with no ~/.wakatime.cfg.
export async function checkWakatime(host: Host): Promise<Result> {
  const arch = WAKATIME_ARCH[process.arch]
  const bin = join(host.home, '.wakatime', 'wakatime-cli')

  if (arch === undefined)
    return { check: 'wakatime', ok: true, detail: `no linux release for ${process.arch}` }

  const release = await host.run(['curl', '-fsSL', '--max-time', '15', WAKATIME_RELEASE])
  const latest = release.code === 0 ? readJsonText<{ tag_name?: string }>(release.stdout)?.tag_name : undefined
  const installedVersion = existsSync(bin) ? (await host.run([bin, '--version'])).stdout.trim().replace(LEADING_V, '') : ''

  if (latest === undefined)
    return { check: 'wakatime', ok: true, detail: `${installedVersion || 'not installed'}, GitHub did not answer: ${firstLine(release.stderr) || 'no release'}` }

  const wanted = latest.replace(LEADING_V, '')

  if (installedVersion !== '' && VERSION.test(installedVersion) && Bun.semver.order(installedVersion, wanted) >= 0)
    return { check: 'wakatime', ok: true, detail: installedVersion }

  return {
    check: 'wakatime',
    ok: false,
    detail: installedVersion === '' ? `${bin} is missing` : `${installedVersion}, ${wanted} released`,
    fix: `download wakatime-cli ${latest} into ${join(host.home, '.wakatime')}`,
    apply: async host => installWakatime(host, latest, arch),
  }
}

const toolCheck = (name: string) => name.slice(name.indexOf('/') + 1)
const OTHER_CHECKS = ['tea', 'hooks', 'needs', 'bun', 'completions', 'workspace', 'wakatime']
const FORGEJO = '@kaynooo/cli-forgejo'
const WORKSPACE = '@kaynooo/cli-workspace'

// The folder repos, sweep and pkg bump look under, and whether it exists.
export function checkWorkspace(host: Host, env: Record<string, string | undefined> = process.env): Result {
  const folder = workspaceRoot({ home: host.home, env })

  if (existsSync(folder))
    return { check: 'workspace', ok: true, detail: folder }

  return { check: 'workspace', ok: false, detail: `${folder} does not exist`, fix: `mkdir -p ${folder}, or set "workspace" in ~/.config/kaynooo-cli/config.json to your folder` }
}

// Every name `runChecks` can be limited to.
export const CHECK_NAMES = [...Object.keys(TOOLS).map(toolCheck), ...OTHER_CHECKS]

// The checks named in `only`; with it empty, those of what is installed: a package left out is no failure.
export async function runChecks(host: Host, only: readonly string[] = []): Promise<Result[]> {
  const wanted = (check: string) => only.length === 0 || only.includes(check)
  const entries = Object.entries(TOOLS).filter(([name]) => only.length === 0 ? isInstalled(host, name) : wanted(toolCheck(name)))
  const { plugin, mod } = hooksWiring(host)
  const hooks = only.length > 0 || plugin || mod !== undefined || isInstalled(host, HOOKS_REQUIRES)
  const tools: Result[] = []

  for (let at = 0; at < entries.length; at += INFO_AT_ONCE)
    tools.push(...await Promise.all(entries.slice(at, at + INFO_AT_ONCE).map(async ([name, bins]) => checkTool(host, name, bins))))

  return [
    ...tools,
    ...wanted('tea') && (only.length > 0 || isInstalled(host, FORGEJO)) ? [await checkTea(host)] : [],
    ...wanted('hooks') && hooks ? [checkHooks(host)] : [],
    ...wanted('needs') ? [checkNeeds(host)] : [],
    ...wanted('bun') ? [checkBun(host)] : [],
    ...wanted('completions') ? [checkCompletions(host)] : [],
    ...wanted('workspace') && (only.length > 0 || isInstalled(host, WORKSPACE) || isInstalled(host, '@kaynooo/cli-pkg')) ? [checkWorkspace(host)] : [],
    ...wanted('wakatime') && existsSync(join(host.home, '.wakatime.cfg')) ? [await checkWakatime(host)] : [],
  ]
}
