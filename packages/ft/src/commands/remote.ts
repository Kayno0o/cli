import { lookup } from 'node:dns/promises'
import { homedir } from 'node:os'
import { fail, note, parse } from '@kaynooo/cli-kit'
import { $ } from 'bun'
import { loadSettings, settingsPath } from '../config'
import { git } from '../git'
import { canonicalRemote, parseSshRemote, reachesHost, redactUrl } from '../remote'

const usage = `ft remote [--fix]

Checks that origin's URLs name the Forgejo host itself: tea only finds the repository when origin's host is the login's ssh_host, never through an ssh alias such as \`forgejo\` or \`gitea\`.
--fix switches every alias URL to \`git@<host>:<owner>/<repo>.git\` and proves it with \`git ls-remote\`.
The host comes from --host, else \`remoteHost\` in ~/.config/ft/config.json; with neither, it checks nothing.

Exits 0 when origin names the Forgejo host (or was switched) or no host is set, 1 when it does not or a switch is still to run, 2 on a usage error.`

const options = {
  host: { type: 'string', description: 'the Forgejo ssh host, instead of remoteHost in ~/.config/ft/config.json' },
  fix: { type: 'boolean', description: 'rewrite the alias URLs' },
} as const

const HOSTNAME = /^hostname (.+)$/m

async function sshHostname(alias: string): Promise<string | undefined> {
  return HOSTNAME.exec(await $`ssh -G -- ${alias}`.quiet().nothrow().text())?.[1]
}

async function addresses(name: string): Promise<string[]> {
  try {
    return (await lookup(name, { all: true })).map(entry => entry.address)
  }
  catch {
    return []
  }
}

// Puts back the URLs `--fix` replaced.
async function restoreOrigin(fetchUrl: string, pushUrls: string[], changes: (readonly [string, string])[]): Promise<void> {
  if (changes.some(([from]) => from === fetchUrl))
    await git(['remote', 'set-url', 'origin', fetchUrl])

  for (const [from, to] of changes) {
    if (pushUrls.includes(from))
      await git(['remote', 'set-url', '--push', 'origin', from, to])
  }
}

function originHost(url: string): string | undefined {
  return parseSshRemote(url)?.host ?? (URL.canParse(url) ? new URL(url).hostname : undefined)
}

export async function remote(args: string[], home = homedir()): Promise<number> {
  const { values } = parse(args, usage, options)
  const host = values.host ?? (await loadSettings(home)).remoteHost

  if (host === undefined) {
    note(`no Forgejo host to check origin against: pass --host, or set "remoteHost" in ${settingsPath(home)}`)

    return 0
  }

  const fetchUrl = await git(['remote', 'get-url', 'origin'])
  const pushUrls = (await $`git config --get-all remote.origin.pushurl`.quiet().nothrow().text()).split('\n').filter(Boolean)
  const hostAddresses = new Set(await addresses(host))
  const hostnames = new Map<string, string | undefined>()
  const reaching = new Set<string>()

  for (const url of [fetchUrl, ...pushUrls]) {
    const alias = parseSshRemote(url)?.host

    if (alias === undefined || hostnames.has(alias))
      continue

    const hostname = await sshHostname(alias)

    hostnames.set(alias, hostname)

    if (await reachesHost(hostname, host, hostAddresses, addresses))
      reaching.add(alias)
  }

  const changes = [fetchUrl, ...pushUrls].map(url => [url, canonicalRemote(url, host, alias => reaching.has(alias))] as const).filter((change): change is readonly [string, string] => change[1] !== undefined)

  if (changes.length === 0) {
    const named = originHost(fetchUrl)

    if (named === host) {
      console.log(`origin already names ${host}: ${redactUrl(fetchUrl)}`)

      return 0
    }

    const hostname = named === undefined ? undefined : hostnames.get(named)

    console.log(`origin ${redactUrl(fetchUrl)} does not reach ${host}${hostname === undefined || hostname === named ? '' : `: ssh connects ${named} to ${hostname}`}, pass --host if Forgejo lives elsewhere`)

    return 1
  }

  for (const [from, to] of changes)
    console.log(`${redactUrl(from)} -> ${redactUrl(to)}`)

  if (values.fix !== true) {
    console.log('run `ft remote --fix` to switch them')

    return 1
  }

  const fetchChange = changes.find(([from]) => from === fetchUrl)

  if (fetchChange !== undefined)
    await git(['remote', 'set-url', 'origin', fetchChange[1]])

  for (const [from, to] of changes) {
    if (pushUrls.includes(from))
      await git(['remote', 'set-url', '--push', 'origin', to, from])
  }

  try {
    await git(['ls-remote', 'origin', 'HEAD'])
  }
  catch (error) {
    await restoreOrigin(fetchUrl, pushUrls, changes)

    return fail(`the switched origin does not answer, so the old URLs were put back: ${redactUrl(error instanceof Error ? error.message : String(error))}`, 1)
  }

  console.log('origin switched, and git ls-remote reaches it')

  return 0
}
