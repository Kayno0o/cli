import type { Forge } from '@kaynooo/cli-kit'
import type { Host, Result } from './check-tools'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { configuredForge, userConfigReadPath } from '@kaynooo/cli-kit'
import { firstLine, ownBin, readJsonText, VERSION } from './check-tools'

// The forge config.json names, which ft's tea login must reach; undefined lets any login do.
function forgeOf(home: string): Forge | undefined {
  return configuredForge({ home, xdg: process.env.XDG_CONFIG_HOME })
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
    return { check: 'tea', ok: false, detail: `tea is not installed and gt has no login: ${firstLine(own.stderr || own.stdout)}`, fix: `gt auth login --host ${forgeOf(host.home)?.url ?? 'https://<forge>'}` }

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
  const forge = forgeOf(host.home)
  const hosts = new Set([...(forge === undefined ? [] : [forge.host]), ...extraForgeHosts(host.home)])
  const login = parsed?.find(each => URL.canParse(each.url) && (hosts.size === 0 || hosts.has(new URL(each.url).host)))

  if (login === undefined)
    return { check: 'tea', ok: false, detail: forge === undefined ? 'no tea login' : `no login to ${forge.host}`, fix: `tea login add --url ${forge?.url ?? 'https://<forge>'} --oauth` }

  const version = await host.run(['tea', 'api', '--login', login.name, 'version'])
  const served = version.code === 0 ? readJsonText<{ version?: string }>(version.stdout)?.version : undefined
  const reached = new URL(login.url).host

  if (served === undefined)
    return { check: 'tea', ok: false, detail: `${reached} did not answer: ${firstLine(version.stderr || version.stdout)}`, fix: `tea login edit ${login.name} --token <token>, or check the network` }

  return { check: 'tea', ok: true, detail: `logged in to ${reached} as ${login.name}, Forgejo ${served}` }
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
    return { check: 'wakatime', ok: true, warn: true, detail: `${installedVersion || 'not installed'}, GitHub did not answer: ${firstLine(release.stderr) || 'no release'}` }

  const wanted = latest.replace(LEADING_V, '')

  if (installedVersion !== '' && VERSION.test(installedVersion) && Bun.semver.order(installedVersion, wanted) >= 0)
    return { check: 'wakatime', ok: true, detail: installedVersion }

  return {
    check: 'wakatime',
    ok: false,
    detail: installedVersion === '' ? `${bin} is missing` : `${installedVersion}, ${wanted} released`,
    fix: `download wakatime-cli ${latest} into ${join(host.home, '.wakatime')}`,
    apply: async on => installWakatime(on, latest, arch),
  }
}

const DL = '@kaynooo/cli-dl'

interface DlEntry { name: string, state: 'current' | 'changed' | 'unreachable', error?: string }

// The commands `dl --bin` installed whose source changed since, as the installed dl's `outdated` tells; a source it cannot reach is said, not failed, as the network is no fault of the install.
export async function checkDlBins(host: Host): Promise<Result> {
  const bin = ownBin(host, DL, 'dl')

  if (bin === undefined)
    return { check: 'dl-bins', ok: true, detail: 'dl is not installed' }

  const ran = await host.run(['bun', bin, 'outdated', '--bins', '--json'])
  const entries = readJsonText<DlEntry[]>(ran.stdout)

  if (!Array.isArray(entries))
    return { check: 'dl-bins', ok: true, detail: `the installed dl cannot tell: ${firstLine(ran.stderr) || `exit ${ran.code}`}` }

  const changed = entries.filter(entry => entry.state === 'changed').map(entry => entry.name)
  const unreachable = entries.filter(entry => entry.state === 'unreachable').map(entry => entry.name)
  const asked = unreachable.length > 0 ? `, the source of ${unreachable.join(', ')} did not answer` : ''

  if (changed.length > 0)
    return { check: 'dl-bins', ok: false, detail: `${changed.join(', ')} changed at the source${asked}`, fix: `dl update ${changed.join(' ')}` }

  return { check: 'dl-bins', ok: true, detail: entries.length === 0 ? 'dl installed no command' : `${entries.length - unreachable.length} commands dl installed are current${asked}` }
}
