import type { Host } from './checks'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { findUp, loadTheme, userConfigReadPath, workspaceRoot } from '@kaynooo/cli-kit'

export interface ConfigSource {
  kind: 'file' | 'env'
  name: string
  where: string
  /** `set` or `absent`, `invalid` for a file that does not parse. */
  status: 'set' | 'absent' | 'invalid'
  /** The value of an environment variable, masked for the ones that hold a secret. */
  value?: string
}

export interface ConfigReport {
  workspace: string
  theme: { preset: string, sources: string[] }
  sources: ConfigSource[]
}

// [bin, older path under the config folder].
const USER_FILES: [string, string[][]][] = [['config', []], ['theme', []], ['doctor', []], ['ft', [['ft', 'config.json']]], ['db', [['db', 'config.json']]], ['pkg', []], ['pkg-excluded', []], ['repos', []]]
const PROJECT_FILES = [join('.kaynooo', 'theme.json'), '.pkgrc.json']
const ENV = ['KAYNOOO_WORKSPACE', 'KAYNOOO_CLI_NO_USAGE', 'KIT_MODE', 'KIT_THEME', 'KIT_HELP', 'NO_COLOR', 'FORCE_COLOR', 'BROWSER', 'EDITOR', 'VISUAL', 'SLOT_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'GITHUB_TOKEN', 'DISCORD_WEBHOOK']
const SECRETS = new Set(['GITHUB_TOKEN', 'DISCORD_WEBHOOK'])

function fileStatus(path: string): ConfigSource['status'] {
  if (!existsSync(path))
    return 'absent'

  try {
    Bun.JSONC.parse(readFileSync(path, 'utf8'))

    return 'set'
  }
  catch {
    return 'invalid'
  }
}

// Every config file a bin reads and every environment variable that changes one, with where it was looked for and whether it is there.
export function configReport(host: Pick<Host, 'home'>, env: Record<string, string | undefined> = process.env, from = process.cwd()): ConfigReport {
  const sources: ConfigSource[] = USER_FILES.map(([bin, legacy]) => {
    const where = userConfigReadPath(bin, legacy, { home: host.home, xdg: env.XDG_CONFIG_HOME })

    return { kind: 'file', name: `${bin}.json`, where, status: fileStatus(where) }
  })

  for (const name of PROJECT_FILES) {
    const where = findUp(name, from)

    sources.push({ kind: 'file', name, where: where ?? `${name} (none found upward from ${from})`, status: where === undefined ? 'absent' : fileStatus(where) })
  }

  for (const name of ENV) {
    const value = env[name]

    sources.push({ kind: 'env', name, where: 'environment', status: value === undefined || value === '' ? 'absent' : 'set', ...value === undefined || value === '' ? {} : { value: SECRETS.has(name) ? '(hidden)' : value } })
  }

  const { sources: themes, preset } = loadTheme({ env, from, home: host.home, warn: () => undefined })

  return { workspace: workspaceRoot({ env, home: host.home }), theme: { preset, sources: themes }, sources }
}
