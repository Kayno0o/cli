import type { Guard } from './kill'
import type { ProcInfo } from './read'
import { basename, join, relative } from 'node:path'
import { protectionOf } from './kill'

const BROWSERS = /^(?:chrom(?:e|ium)(?:-browser)?|google-chrome(?:-stable|-beta|-unstable)?|chrome_crashpad_handler|chrome-headless-shell|headless_shell|chromium-headless-shell|brave|brave-browser|msedge|microsoft-edge|webkitwebprocess|webkitnetworkprocess|webkitgpuprocess|minibrowser|webkitwebdriver|wpewebprocess|wpenetworkprocess|bun-webview.*)$/i
const NATIVE = new Set(['rust-analyzer', 'gopls', 'clangd', 'lua-language-server', 'pyright-langserver', 'pylsp', 'intelephense', 'phpactor', 'tsgo', 'esbuild', 'biome', 'ruff', 'phpunit', 'pytest', 'vitest', 'jest'])
const RUNTIMES = new Set(['node', 'bun', 'bunx', 'deno', 'nodejs'])
const SCRIPTS = new Set(['vite', 'vitest', 'nuxt', 'nuxi', 'next', 'jest', 'playwright', 'playwright-core', 'tsserver', 'typescript-language-server', 'vue-language-server', 'vtsls', 'eslint_d', 'esbuild', 'webpack', 'turbo', 'astro', 'tsgo', 'svelte-kit', 'remix', 'storybook', 'biome', 'prettierd', 'tailwindcss', 'bun-webview'])
const EXTENSION = /\.[cm]?[jt]s$/
const MARKERS = ['package.json', 'composer.json', 'Cargo.toml', 'go.mod', 'pyproject.toml']
// Chromium re-runs itself with these for helpers, and a main process with these is driven by a script rather than opened by hand.
const AUTOMATION = /^--(?:headless|remote-debugging-(?:pipe|port)|enable-automation)/

export const HEAVY_DEFAULT = 500 * 1024 ** 2

// The dev tool a process is, undefined for anything else: `chromium`, `vite`, `bun`, `rust-analyzer`.
export function toolOf(proc: Pick<ProcInfo, 'comm' | 'args' | 'exe'>): string | undefined {
  const names = [proc.exe, proc.args[0], proc.comm].filter((name): name is string => name !== undefined && name !== '').map(name => basename(name))

  for (const name of names) {
    if (BROWSERS.test(name))
      return name.toLowerCase().startsWith('webkit') || name.toLowerCase().startsWith('wpe') || name.toLowerCase() === 'minibrowser' ? 'webkit' : 'chromium'

    if (NATIVE.has(name))
      return name
  }

  const runtime = names.find(name => RUNTIMES.has(name))

  if (runtime === undefined)
    return undefined

  for (const arg of proc.args.slice(1)) {
    if (arg.startsWith('-'))
      continue

    const script = basename(arg).replace(EXTENSION, '')

    if (SCRIPTS.has(script))
      return script
  }

  return runtime === 'nodejs' ? 'node' : runtime
}

export function userDataDir(args: string[]): string | undefined {
  const arg = args.find(word => word.startsWith('--user-data-dir='))

  return arg?.slice('--user-data-dir='.length)
}

// The nearest folder up from `cwd` holding a `.git`, else one holding a package or build manifest, never the home folder or above.
export function projectOf(cwd: string | undefined, exists: (path: string) => boolean, home: string): string | undefined {
  if (cwd === undefined || !cwd.startsWith(`${home}/`))
    return undefined

  const folders: string[] = []

  for (let dir = cwd; dir.startsWith(`${home}/`); dir = join(dir, '..'))
    folders.push(dir)

  return folders.find(dir => exists(join(dir, '.git'))) ?? folders.find(dir => MARKERS.some(marker => exists(join(dir, marker))))
}

// Whether a process was left behind: reparented to init or to the user's systemd. A systemd service of its own is managed, not left over, and a browser is only one when a script drives it or it is a helper whose main process may be gone.
export function isOrphan(proc: ProcInfo, byPid: Map<number, ProcInfo>): boolean {
  if (proc.unit?.endsWith('.service') === true)
    return false

  const parent = byPid.get(proc.ppid)
  const userManager = parent !== undefined && parent.comm === 'systemd' && parent.uid === proc.uid && parent.uid !== 0
  const reparented = proc.ppid === 1 || userManager

  const tool = toolOf(proc)

  if (!reparented || (tool !== 'chromium' && tool !== 'webkit'))
    return reparented

  // The crashpad handler detaches from its browser by design.
  if (basename(proc.exe ?? proc.args[0] ?? proc.comm).includes('crashpad'))
    return false

  return proc.args.some(arg => arg.startsWith('--type=')) || proc.args.some(arg => AUTOMATION.test(arg))
}

export interface Member {
  proc: ProcInfo
  tool: string
  orphan: boolean
  heavy: boolean
  ageMs: number
}

export type GroupKind = 'project' | 'profile' | 'command'

export interface Group {
  key: string
  origin: string
  kind: GroupKind
  members: Member[]
  rss: number
  oldestMs: number
  orphans: number
}

export interface SelectOptions {
  guard: Guard
  now: number
  home: string
  exists: (path: string) => boolean
  // Resident bytes from which a process is heavy, and when given also the least a left over one must use to be listed.
  minMem?: number | undefined
  // The least age of a process to be listed.
  olderMs?: number | undefined
}

export interface Selection {
  groups: Group[]
  // Processes that qualified but must never be signalled, left out.
  protectedCount: number
}

function originOf(proc: ProcInfo, tool: string, { exists, home }: SelectOptions): { key: string, origin: string, kind: GroupKind } {
  const profile = userDataDir(proc.args)

  if (profile !== undefined)
    return { key: `profile:${profile}`, origin: `${tool} profile ${profile}`, kind: 'profile' }

  const project = projectOf(proc.cwd, exists, home)

  if (project !== undefined)
    return { key: `project:${project}`, origin: `~/${relative(home, project)}`, kind: 'project' }

  return { key: `command:${tool}`, origin: tool, kind: 'command' }
}

// The leftover or heavy dev processes of the calling user, grouped by origin. A selected process pulls in the dev processes below it, and those sharing its browser profile, so a browser whose main process is gone still groups with its helpers.
export function selectGroups(procs: ProcInfo[], options: SelectOptions): Selection {
  const byPid = new Map(procs.map(proc => [proc.pid, proc]))
  const heavyFrom = options.minMem ?? HEAVY_DEFAULT
  const candidates = procs.filter(proc => proc.uid === options.guard.uid && proc.pid !== 1 && toolOf(proc) !== undefined)
  const chosen = new Map<number, { orphan: boolean, heavy: boolean }>()
  let protectedCount = 0

  for (const proc of candidates) {
    const ageMs = options.now - proc.startMs
    const orphan = isOrphan(proc, byPid)
    const heavy = proc.rss >= heavyFrom

    if (!(heavy || (orphan && proc.rss >= (options.minMem ?? 0))) || ageMs < (options.olderMs ?? 0))
      continue

    if (protectionOf(proc, options.guard) !== undefined) {
      protectedCount++

      continue
    }

    chosen.set(proc.pid, { orphan, heavy })
  }

  const profiles = new Set([...chosen.keys()].map(pid => userDataDir(byPid.get(pid)!.args)).filter(dir => dir !== undefined))
  let grew = true

  while (grew) {
    grew = false

    for (const proc of candidates) {
      const dir = userDataDir(proc.args)
      const joins = chosen.has(proc.ppid) || (dir !== undefined && profiles.has(dir))

      if (chosen.has(proc.pid) || !joins || protectionOf(proc, options.guard) !== undefined)
        continue

      chosen.set(proc.pid, { orphan: isOrphan(proc, byPid), heavy: proc.rss >= heavyFrom })
      grew = true
    }
  }

  const groups = new Map<string, Group>()

  for (const [pid, flags] of chosen) {
    const proc = byPid.get(pid)!
    const tool = toolOf(proc)!
    const { key, origin, kind } = originOf(proc, tool, options)
    const group = groups.get(key) ?? { key, origin, kind, members: [], rss: 0, oldestMs: 0, orphans: 0 }
    const ageMs = options.now - proc.startMs

    group.members.push({ proc, tool, ageMs, ...flags })
    group.rss += proc.rss
    group.oldestMs = Math.max(group.oldestMs, ageMs)
    group.orphans += flags.orphan ? 1 : 0
    groups.set(key, group)
  }

  for (const group of groups.values())
    group.members.sort((a, b) => a.proc.pid - b.proc.pid)

  return { groups: [...groups.values()].sort((a, b) => b.rss - a.rss), protectedCount }
}
