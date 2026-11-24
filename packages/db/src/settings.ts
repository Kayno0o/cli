import { readMainConfig, userConfigReadPath, warn } from '@kaynooo/cli-kit'

// What ~/.config/kaynooo-cli/config.json(c) (`db` section) or ~/.config/kaynooo-cli/db.json (or legacy ~/.config/db/config.json) may set; every key is optional and nothing is assumed without it.
export interface DbSettings {
  // Hosts other than the loopback and the compose services that db may connect to: `db.example.com`.
  allowedHosts?: string[]
}

export function settingsPath(home?: string): string {
  return userConfigReadPath('db', [['db', 'config.json']], { home })
}

function hostsOf(raw: unknown): string[] {
  const hosts = typeof raw === 'object' && raw !== null && 'allowedHosts' in raw && Array.isArray(raw.allowedHosts) ? raw.allowedHosts : []

  return hosts.filter((host): host is string => typeof host === 'string' && host !== '')
}

// The global settings, empty when missing; the `db` section of config.json(c) wins over a legacy db.json file.
export async function loadSettings(home?: string): Promise<DbSettings> {
  const fromMain = readMainConfig({ home }).db

  if (typeof fromMain === 'object' && fromMain !== null && !Array.isArray(fromMain)) {
    const allowedHosts = hostsOf(fromMain)

    if (allowedHosts.length > 0)
      return { allowedHosts }
  }

  const path = settingsPath(home)
  const file = Bun.file(path)

  if (!await file.exists())
    return {}

  let raw: unknown

  try {
    raw = Bun.JSONC.parse(await file.text())
  }
  catch {
    warn(`${path} is not valid JSON, ignored: only local hosts are allowed`)

    return {}
  }

  const allowedHosts = hostsOf(raw)

  return allowedHosts.length > 0 ? { allowedHosts } : {}
}
