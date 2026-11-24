import type { Forge } from '@kaynooo/cli-kit'
import type { Host, Result } from './check-tools'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { configuredForge, readUserConfig } from '@kaynooo/cli-kit'
import { firstLine, ownBin, readJsonText } from './check-tools'

// The forge config.json names, which ft's tea login must reach; undefined lets any login do.
function forgeOf(home: string): Forge | undefined {
  return configuredForge({ home, xdg: process.env.XDG_CONFIG_HOME })
}

// Other hosts the same forge answers on, from `doctor.forgeHosts` in config.json(c) or legacy doctor.json.
function extraForgeHosts(home: string): string[] {
  const raw = readUserConfig('doctor', { home, xdg: process.env.XDG_CONFIG_HOME }).forgeHosts

  return Array.isArray(raw) ? raw.filter((each): each is string => typeof each === 'string') : []
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
    return { check: 'dl-bins', ok: false, detail: `${changed.join(', ')} changed at the source${asked}`, fix: `dl update ${changed.join(' ')}`, fixAction: { kind: 'run', argv: ['dl', 'update', ...changed] } }

  return { check: 'dl-bins', ok: true, detail: entries.length === 0 ? 'dl installed no command' : `${entries.length - unreachable.length} commands dl installed are current${asked}` }
}
