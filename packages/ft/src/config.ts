import { homedir } from 'node:os'
import { join } from 'node:path'

// What ~/.config/ft/config.json may set; every key is optional and nothing is assumed without it.
export interface FtSettings {
  // The Forgejo ssh host `ft remote` switches alias origins to: `git.example.com`.
  remoteHost?: string
}

export function settingsPath(home = homedir()): string {
  return join(home, '.config', 'ft', 'config.json')
}

// The global settings, empty when the file is missing; a file that is not a JSON object is ignored too.
export async function loadSettings(home = homedir()): Promise<FtSettings> {
  const file = Bun.file(settingsPath(home))

  if (!await file.exists())
    return {}

  let raw: unknown

  try {
    raw = await file.json()
  }
  catch {
    return {}
  }

  const host = typeof raw === 'object' && raw !== null && 'remoteHost' in raw ? raw.remoteHost : undefined

  return typeof host === 'string' && host !== '' ? { remoteHost: host } : {}
}
