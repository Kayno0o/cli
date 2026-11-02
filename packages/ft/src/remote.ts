// An ssh remote, scp-like (`git@host:owner/repo.git`, `host:owner/repo`) or a URL (`ssh://git@host:22/owner/repo.git`).
const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+?)(?:\.git)?\/?$/
const SSH_URL = /^ssh:\/\/(?:([^@/]+)@)?([^:/]+)(?::(\d+))?\/(.+?)(?:\.git)?\/?$/
const USERINFO = /^([a-z][a-z\d+.-]*:\/\/)[^@/]*@/i
const DEFAULT_PORT = '22'

export interface SshRemote { user: string, host: string, path: string, port?: string }

// A host starting with a dash is read by ssh as an option, so it names no remote.
export function parseSshRemote(url: string): SshRemote | undefined {
  const ssh = SSH_URL.exec(url)
  const scp = ssh === null && !url.includes('://') ? SCP_LIKE.exec(url) : null
  const match = ssh ?? scp

  if (match === null || match[2]?.startsWith('-') === true)
    return undefined

  // A password or token written after the user (`user:token@`) is not part of the user.
  const login = match[1] ?? 'git'
  const user = login.includes(':') ? login.slice(0, login.indexOf(':')) : login

  if (ssh === null)
    return { user, host: match[2] ?? '', path: match[3] ?? '' }

  return { user, host: match[2] ?? '', path: match[4] ?? '', ...ssh[3] === undefined ? {} : { port: ssh[3] } }
}

// The url without a `user:token@` it carries, for printing.
export function redactUrl(url: string): string {
  return url.replace(USERINFO, '$1')
}

// The `git@<host>:<owner>/<repo>.git` form tea matches a login's ssh_host against, for a remote whose host is an ssh alias that reaches <host>; undefined when it needs no change. A port other than 22 written in the url stays, which only the URL form can carry.
export function canonicalRemote(url: string, host: string, reaches: (alias: string) => boolean): string | undefined {
  const remote = parseSshRemote(url)

  if (remote === undefined || remote.host === host || !reaches(remote.host))
    return undefined

  if (remote.port !== undefined && remote.port !== DEFAULT_PORT)
    return `ssh://${remote.user}@${host}:${remote.port}/${remote.path}.git`

  return `${remote.user}@${host}:${remote.path}.git`
}

// Whether ssh, connecting an alias to <hostname>, reaches <host>: by its name, or by an address <host> resolves to, as a LAN IP does.
export async function reachesHost(hostname: string | undefined, host: string, hostAddresses: Set<string>, addressesOf: (name: string) => Promise<string[]>): Promise<boolean> {
  if (hostname === undefined)
    return false

  return hostname === host || (await addressesOf(hostname)).some(address => hostAddresses.has(address))
}
