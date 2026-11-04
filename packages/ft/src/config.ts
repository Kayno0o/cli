import { userConfigReadPath, warn } from '@kaynooo/cli-kit'

// What ~/.config/kaynooo-cli/ft.json (or the older ~/.config/ft/config.json) may set; every key is optional and nothing is assumed without it.
export interface FtSettings {
  // The Forgejo ssh host `ft remote` switches alias origins to: `git.example.com`.
  remoteHost?: string
}

export function settingsPath(home?: string): string {
  return userConfigReadPath('ft', [['ft', 'config.json']], { home })
}

// The global settings, empty when the file is missing; a file that is not a JSON object, or a host that is no string, is ignored with a warning.
export async function loadSettings(home?: string): Promise<FtSettings> {
  const path = settingsPath(home)
  const file = Bun.file(path)

  if (!await file.exists())
    return {}

  let raw: unknown

  try {
    raw = await file.json()
  }
  catch (error) {
    warn(`${path} is not valid JSON, so its settings are ignored`, error instanceof Error ? error.message : String(error))

    return {}
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn(`${path} is not a JSON object, so its settings are ignored`)

    return {}
  }

  const host = 'remoteHost' in raw ? raw.remoteHost : undefined

  if (host !== undefined && (typeof host !== 'string' || host === ''))
    warn(`remoteHost in ${path} must be a non-empty string, so it is ignored`)

  return typeof host === 'string' && host !== '' ? { remoteHost: host } : {}
}
