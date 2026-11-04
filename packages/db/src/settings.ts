import { userConfigReadPath, warn } from '@kaynooo/cli-kit'

// What ~/.config/kaynooo-cli/db.json (or the older ~/.config/db/config.json) may set; every key is optional and nothing is assumed without it.
export interface DbSettings {
  // Hosts other than the loopback and the compose services that db may connect to: `db.example.com`.
  allowedHosts?: string[]
}

export function settingsPath(home?: string): string {
  return userConfigReadPath('db', [['db', 'config.json']], { home })
}

// The global settings, empty when the file is missing; a file that does not parse is ignored with a warning, so the allowlist stays empty.
export async function loadSettings(home?: string): Promise<DbSettings> {
  const path = settingsPath(home)
  const file = Bun.file(path)

  if (!await file.exists())
    return {}

  let raw: unknown

  try {
    raw = await file.json()
  }
  catch {
    warn(`${path} is not valid JSON, ignored: only local hosts are allowed`)

    return {}
  }

  const hosts = typeof raw === 'object' && raw !== null && 'allowedHosts' in raw && Array.isArray(raw.allowedHosts) ? raw.allowedHosts : []
  const allowedHosts = hosts.filter((host): host is string => typeof host === 'string' && host !== '')

  return allowedHosts.length > 0 ? { allowedHosts } : {}
}
