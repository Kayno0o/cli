import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findUp, readUserConfig } from '@kaynooo/cli-kit'

export interface GuardConfig {
  // Rule names to skip (e.g. `commit`, `edit`, `remote`).
  disable: string[]
  // Remote hosts allowed by the `remote` rule (exact host or user@host match).
  allowHosts: string[]
  // Extra path segments/prefixes protected from recursive deletion in addition to workspaceRoot() and `.git`.
  protectPaths: string[]
  // Regex patterns for commands explicitly allowed to bypass rules.
  allowCommands: string[]
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
}

function parseLayer(raw: unknown): Partial<GuardConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return {}

  const obj = raw as Record<string, unknown>

  return {
    disable: stringList(obj.disable),
    allowHosts: stringList(obj.allowHosts),
    protectPaths: stringList(obj.protectPaths),
    allowCommands: stringList(obj.allowCommands),
  }
}

function readProjectConfig(cwd: string, home: string): Partial<GuardConfig> {
  const path = findUp(join('.kaynooo', 'guard.json'), cwd, dir => dir === resolve(home) || existsSync(join(dir, '.git')))

  if (path === undefined)
    return {}

  try {
    return parseLayer(Bun.JSONC.parse(readFileSync(path, 'utf8')))
  }
  catch {
    return {}
  }
}

// Loads guard settings from unified config (`guard` section or legacy guard.json) merged with upward `.kaynooo/guard.json`.
export function loadGuardConfig(cwd: string, home: string): GuardConfig {
  const user = parseLayer(readUserConfig('guard', { home }))
  const project = readProjectConfig(cwd, home)
  const merge = (a: string[] | undefined, b: string[] | undefined) => [...new Set([...(a ?? []), ...(b ?? [])])]

  return {
    disable: merge(user.disable, project.disable),
    allowHosts: merge(user.allowHosts, project.allowHosts),
    protectPaths: merge(user.protectPaths, project.protectPaths),
    allowCommands: merge(user.allowCommands, project.allowCommands),
  }
}
