// An ssh remote, scp-like (`git@host:owner/repo.git`, `host:owner/repo`) or a URL (`ssh://git@host:22/owner/repo.git`).
const SCP_LIKE = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+?)(?:\.git)?\/?$/
const SSH_URL = /^ssh:\/\/(?:([^@/]+)@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/

export interface SshRemote { user: string, host: string, path: string }

export function parseSshRemote(url: string): SshRemote | undefined {
  const match = SSH_URL.exec(url) ?? (url.includes('://') ? null : SCP_LIKE.exec(url))

  return match === null ? undefined : { user: match[1] ?? 'git', host: match[2] ?? '', path: match[3] ?? '' }
}

// The `git@<host>:<owner>/<repo>.git` form tea matches a login's ssh_host against, for a remote whose host is an ssh alias that reaches <host>; undefined when it needs no change.
export function canonicalRemote(url: string, host: string, reaches: (alias: string) => boolean): string | undefined {
  const remote = parseSshRemote(url)

  if (remote === undefined || remote.host === host || !reaches(remote.host))
    return undefined

  return `${remote.user}@${host}:${remote.path}.git`
}

// Whether ssh, connecting an alias to <hostname>, reaches <host>: by its name, or by an address <host> resolves to, as a LAN IP does.
export async function reachesHost(hostname: string | undefined, host: string, hostAddresses: Set<string>, addressesOf: (name: string) => Promise<string[]>): Promise<boolean> {
  if (hostname === undefined)
    return false

  return hostname === host || (await addressesOf(hostname)).some(address => hostAddresses.has(address))
}
