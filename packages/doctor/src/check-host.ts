import type { Host, Result } from './check-tools'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { workspaceRoot } from '@kaynooo/cli-kit'
import { HOOKS_REQUIRES } from './catalog'
import { isInstalled, readJson } from './check-tools'
import { completionDir, missingCompletions, staleCompletions } from './completions'

const PLUGIN = 'cli-hooks@kaynooo-cli'

// The public GitHub copy: the Forgejo repo is private, and the marketplace is cloned without credentials.
export const MARKETPLACE = 'https://github.com/Kayno0o/cli.git'
const LEADING_TILDE = /^~(?=\/|$)/

// How the hooks are wired: the cli-hooks plugin, the dotfiles' cli mod (the folder holding it), both or neither.
export function hooksWiring(host: Host): { plugin: boolean, mod: string | undefined } {
  const settings = readJson<{ enabledPlugins?: Record<string, boolean>, env?: Record<string, string> }>(join(host.home, '.claude', 'settings.json')) ?? {}
  const plugin = settings.enabledPlugins?.[PLUGIN] === true
  const mod = (settings.env?.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(':').map(dir => dir.replace(LEADING_TILDE, host.home)).find(dir => basename(dir) === 'cli' && existsSync(join(dir, 'hooks', 'hooks.json')))

  return { plugin, mod }
}

// The hooks wired one way exactly: the cli-hooks plugin or the dotfiles' cli mod, never both, and the guard they call installed.
export function checkHooks(host: Host): Result {
  const { plugin, mod } = hooksWiring(host)

  if ((plugin || mod !== undefined) && !isInstalled(host, HOOKS_REQUIRES))
    return { check: 'hooks', ok: false, detail: `wired, but ${HOOKS_REQUIRES} is not installed, so every hook finds no guard`, fix: `bun install -g ${HOOKS_REQUIRES}` }

  if (plugin && mod !== undefined)
    return { check: 'hooks', ok: false, detail: `both the ${PLUGIN} plugin and the mod in ${mod} run guard, so every call is checked twice`, fix: `claude plugin disable ${PLUGIN}` }

  if (plugin)
    return { check: 'hooks', ok: true, detail: `the ${PLUGIN} plugin` }

  if (mod !== undefined)
    return { check: 'hooks', ok: true, detail: `the cli mod in ${mod}` }

  return { check: 'hooks', ok: false, detail: 'neither the plugin nor the cli mod is wired into ~/.claude/settings.json', fix: `claude plugin install cli-hooks --marketplace ${MARKETPLACE}` }
}

function checkRcCompletions(home: string, shell: 'bash' | 'zsh'): Result {
  const rc = join(home, `.${shell}rc`)
  const line = `source <(cli completions ${shell})`
  const text = existsSync(rc) ? readFileSync(rc, 'utf8') : ''

  if (text.includes(`cli completions ${shell}`))
    return { check: 'completions', ok: true, detail: rc }

  return {
    check: 'completions',
    ok: false,
    detail: `${shell} does not load them`,
    fix: `append ${line} to ${rc}`,
    apply: async () => {
      await appendFile(rc, `${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`)

      return undefined
    },
  }
}

// A bash or zsh login shell sources the script from its rc file; otherwise fish, when installed, completes every installed bin.
export function checkCompletions(host: Host): Result {
  if (host.shell === 'zsh' || host.shell === 'bash')
    return checkRcCompletions(host.home, host.shell)

  if (host.which('fish') === null)
    return { check: 'completions', ok: true, detail: 'neither fish, nor bash or zsh as the login shell' }

  const dir = completionDir(host.home)
  const missing = missingCompletions(host, dir)
  const stale = staleCompletions(host, dir)

  if (missing.length > 0 || stale.length > 0)
    return { check: 'completions', ok: false, detail: [missing.length > 0 ? `no fish completion in ${dir} for ${missing.join(', ')}` : '', stale.length > 0 ? `completions in ${dir} for bins no longer installed: ${stale.join(', ')}` : ''].filter(Boolean).join('; '), fix: 'cli completions fish --install' }

  return { check: 'completions', ok: true, detail: dir }
}

// The folder repos, sweep and pkg bump look under, and whether it exists.
export function checkWorkspace(host: Host, env: Record<string, string | undefined> = process.env): Result {
  const folder = workspaceRoot({ home: host.home, env })

  if (existsSync(folder))
    return { check: 'workspace', ok: true, detail: folder }

  return { check: 'workspace', ok: false, detail: `${folder} does not exist`, fix: `mkdir -p ${folder}, or set "workspace" in ~/.config/kaynooo-cli/config.json to your folder` }
}
