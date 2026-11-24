import { configuredNumber, readMainConfig, userConfigReadPath, warn } from '@kaynooo/cli-kit'

// What ~/.config/kaynooo-cli/config.json(c) (`ft` section) or ~/.config/kaynooo-cli/ft.json (or legacy ~/.config/ft/config.json) may set; every key is optional and nothing is assumed without it.
export interface FtSettings {
  // The Forgejo ssh host `ft remote` switches alias origins to: `git.example.com`.
  remoteHost?: string
}

// The `concurrency` key: calls to the forge in flight at once when ft reads comments or milestone issues, `fallback` when it is not set.
export function concurrencyOf(fallback: number, home?: string): number {
  return configuredNumber('ft', 'concurrency', fallback, { home }, [['ft', 'config.json']])
}

export function settingsPath(home?: string): string {
  return userConfigReadPath('ft', [['ft', 'config.json']], { home })
}

// The global settings, empty when missing; the `ft` section of config.json(c) wins over a legacy ft.json file.
export async function loadSettings(home?: string): Promise<FtSettings> {
  const fromMain = readMainConfig({ home }).ft

  if (typeof fromMain === 'object' && fromMain !== null && !Array.isArray(fromMain) && 'remoteHost' in fromMain) {
    const host = (fromMain as { remoteHost?: unknown }).remoteHost

    if (typeof host === 'string' && host !== '')
      return { remoteHost: host }
  }

  const path = settingsPath(home)
  const file = Bun.file(path)

  if (!await file.exists())
    return {}

  let raw: unknown

  try {
    raw = Bun.JSONC.parse(await file.text())
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
