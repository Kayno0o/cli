import type { Choice } from '@kaynooo/cli-kit/prompt'
import type { Host } from './checks'
import process from 'node:process'
import { badUsage, isInteractive, paint, saveWorkspace, userConfigPath, workspaceChosen } from '@kaynooo/cli-kit'
import { checklist, completePath, confirm, input } from '@kaynooo/cli-kit/prompt'
import { ABOUT, HOOKS_REQUIRES, NEEDS } from './catalog'
import { firstLine, FORGE, hooksWiring, isInstalled, TOOLS } from './checks'

// What `doctor --install` can add: a package, or the Claude Code hooks plugin that calls guard.
export interface Candidate {
  id: string
  // The words typed after --install to name it.
  names: string[]
  label: string
  hint: string
  packages: string[]
  installed: boolean
}

export interface InstallOptions {
  names: readonly string[]
  list: boolean
  dryRun: boolean
  force: boolean
}

const HOOKS = 'hooks'
const PLUGIN_UNINSTALL = ['claude', 'plugin', 'uninstall', 'cli-hooks']
const PLUGIN_INSTALL = ['claude', 'plugin', 'install', 'cli-hooks', '--marketplace', `https://${FORGE}/kaynooo/cli.git`]

const CLI_PREFIX = /^cli-/
const shortName = (name: string) => name.slice(name.indexOf('/') + 1).replace(CLI_PREFIX, '')

// Every package and the hooks plugin, installed or not; hooks wired by hand as a mod are left out, as this cannot add or take them away.
function candidates(host: Host): Candidate[] {
  const packages = Object.entries(TOOLS).map(([name, bins]): Candidate => {
    const needs = (NEEDS[name] ?? []).map(need => need.bin)

    return { id: name, names: [shortName(name), name, `cli-${shortName(name)}`, ...bins], label: shortName(name), hint: `${bins.join(' ')}: ${ABOUT[name] ?? ''}${needs.length === 0 ? '' : `, needs ${needs.join(', ')}`}`, packages: [name], installed: isInstalled(host, name) }
  })
  const { plugin, mod } = hooksWiring(host)

  if (mod !== undefined && !plugin)
    return packages

  return [...packages, { id: HOOKS, names: [HOOKS, 'plugin', 'cli-hooks'], label: 'hooks', hint: `the Claude Code plugin running guard on every tool call, needs ${HOOKS_REQUIRES}`, packages: isInstalled(host, HOOKS_REQUIRES) ? [] : [HOOKS_REQUIRES], installed: plugin }]
}

function choose(pool: readonly Candidate[], names: readonly string[]): Candidate[] {
  const chosen = new Set<Candidate>()

  for (const name of names) {
    if (name === 'all') {
      for (const each of pool)
        chosen.add(each)

      continue
    }

    const found = pool.find(each => each.names.includes(name))

    if (found !== undefined)
      chosen.add(found)
  }

  return [...chosen]
}

export interface Plan {
  packages: string[]
  plugin: boolean
  // Packages left out because a tool they require is missing.
  blocked: { package: string, need: string, why: string, how: string }[]
  warnings: { package: string, need: string, why: string }[]
}

export function plan(host: Host, picked: readonly Candidate[], force: boolean): Plan {
  const blocked: Plan['blocked'] = []
  const warnings: Plan['warnings'] = []
  const packages: string[] = []

  for (const name of new Set(picked.flatMap(each => each.packages))) {
    const lacking = (NEEDS[name] ?? []).filter(need => host.which(need.bin) === null)

    if (lacking.length > 0 && !force) {
      for (const need of lacking)
        blocked.push({ package: shortName(name), need: need.bin, why: need.why, how: need.how })

      continue
    }

    for (const need of lacking)
      warnings.push({ package: shortName(name), need: need.bin, why: need.why })

    packages.push(name)
  }

  const guardBlocked = blocked.some(each => `@kaynooo/cli-${each.package}` === HOOKS_REQUIRES)

  return { packages, plugin: picked.some(each => each.id === HOOKS) && !guardBlocked, blocked, warnings }
}

// The names of the checks that follow what was installed.
function checksFor(packages: readonly string[], plugin: boolean): string[] {
  return [...packages.map(name => name.slice(name.indexOf('/') + 1)), ...plugin ? ['hooks'] : [], 'needs', 'completions', ...packages.includes('@kaynooo/cli-forgejo') ? ['tea'] : []]
}

// Every candidate in a checklist with the installed ones checked: what is checked and was not gets installed, what was checked and is not any more gets removed. Undefined once cancelled.
async function ask(all: readonly Candidate[]): Promise<{ add: Candidate[], remove: Candidate[] } | undefined> {
  if (!isInteractive())
    badUsage('name what to install, or all: doctor --install forgejo check hooks (doctor --install --list shows the choices)')

  const choices: Choice<Candidate>[] = all.map(each => ({ value: each, label: each.label, hint: `${each.installed ? 'installed, ' : ''}${each.hint}` }))
  const picked = await checklist('installed packages', choices, { initial: new Set(all.filter(each => each.installed)), hint: 'check to install, uncheck to remove: doctor --install forgejo check names them' })

  if (picked === undefined)
    return undefined

  const remove = all.filter(each => !picked.has(each) && each.installed)

  // Unchecking is easy to do by accident, so the removal is confirmed; declining keeps what is installed and still adds what was checked.
  if (remove.length > 0 && await confirm(`remove ${remove.map(each => each.label).join(', ')}?`, { default: false }) !== true)
    return { add: all.filter(each => picked.has(each) && !each.installed), remove: [] }

  return { add: all.filter(each => picked.has(each) && !each.installed), remove }
}

// What removing the candidates takes out: their packages, except guard while the hooks plugin stays, and the plugin itself.
export function removal(all: readonly Candidate[], remove: readonly Candidate[]): { packages: string[], plugin: boolean } {
  const keepsGuard = all.some(each => each.id === HOOKS && each.installed && !remove.includes(each))

  return { packages: [...new Set(remove.flatMap(each => each.id === HOOKS ? [] : each.packages))].filter(name => !(keepsGuard && name === HOOKS_REQUIRES)), plugin: remove.some(each => each.id === HOOKS) }
}

// On a terminal, asks where the repositories live when the user has not said, and keeps the answer in the user config; off one, or with the folder already chosen, it asks nothing.
async function askWorkspace(host: Host): Promise<void> {
  if (!isInteractive() || workspaceChosen({ home: host.home }))
    return

  const folder = await input('folder holding your repositories (repos, sweep and pkg bump look there)', { default: '~/Workspace', complete: before => completePath(before, process.cwd(), host.home).filter(path => path.endsWith('/')) })

  if (folder !== undefined && folder !== '' && !saveWorkspace(folder, { home: host.home }))
    console.error(`could not write the workspace into ${userConfigPath('config', { home: host.home })}: it does not parse, fix it by hand`)
}

// Installs what the user names or picks, refusing a package whose required tool is missing unless --force, then checks and fixes what it installed through `recheck`.
export async function install(host: Host, options: InstallOptions, recheck: (only: string[]) => Promise<number>, choosing = ask): Promise<number> {
  const all = candidates(host)
  const pool = all.filter(each => !each.installed)
  const { dim, green, red, yellow } = paint(process.stdout)

  if (options.list) {
    for (const each of pool)
      console.log(`${each.label.padEnd(12)} ${dim(each.hint)}`)

    if (pool.length === 0)
      console.log('everything is installed')

    return 0
  }

  if (pool.length === 0 && (options.names.length > 0 || !isInteractive())) {
    console.log('everything is installed')

    return 0
  }

  const unknown = options.names.filter(name => name !== 'all' && !all.some(each => each.names.includes(name)))

  if (unknown.length > 0)
    badUsage(`nothing to install is named ${unknown.join(', ')}: doctor --install --list`)

  const chosen = options.names.length === 0 ? await choosing(all) : { add: choose(pool, options.names), remove: [] }
  const picked = chosen?.add ?? []
  const skipped = options.names.filter(name => name !== 'all' && !pool.some(each => each.names.includes(name)))

  for (const name of skipped)
    console.log(`${dim('already')}  ${name} is installed`)

  const removing = removal(all, chosen?.remove ?? [])
  const removes = removing.packages.length > 0 || removing.plugin

  if (picked.length === 0 && !removes) {
    if (skipped.length === 0)
      console.log('nothing changed')

    return 0
  }

  const planned = plan(host, picked, options.force)

  for (const each of planned.blocked)
    console.log(`${red('blocked')}  ${each.package} needs ${each.need} (${each.why}): ${each.how}; --force installs it anyway`)

  for (const each of planned.warnings)
    console.log(`${yellow('warn   ')}  ${each.package}: ${each.need} is missing, ${each.why}`)

  if (planned.packages.length === 0 && !planned.plugin && !removes)
    return 1

  if (!options.dryRun && planned.packages.some(name => name === '@kaynooo/cli-workspace' || name === '@kaynooo/cli-pkg'))
    await askWorkspace(host)

  const command = ['bun', 'install', '-g', ...planned.packages]

  if (planned.packages.length > 0)
    console.log(`${options.dryRun ? dim('would  ') : green('install')}  ${command.join(' ')}`)

  if (planned.plugin)
    console.log(`${options.dryRun ? dim('would  ') : green('install')}  ${PLUGIN_INSTALL.join(' ')}`)

  const uninstall = ['bun', 'remove', '-g', ...removing.packages]

  if (removing.packages.length > 0)
    console.log(`${options.dryRun ? dim('would  ') : green('remove ')}  ${uninstall.join(' ')}`)

  if (removing.plugin)
    console.log(`${options.dryRun ? dim('would  ') : green('remove ')}  ${PLUGIN_UNINSTALL.join(' ')}`)

  if (options.dryRun)
    return planned.blocked.length > 0 ? 1 : 0

  if (planned.packages.length > 0) {
    const ran = await host.run(command)

    if (ran.code !== 0) {
      console.error(`${red('failed')}   bun install -g: exit ${ran.code}: ${firstLine(ran.stderr || ran.stdout)}`)

      return 1
    }
  }

  if (planned.plugin) {
    if (host.which('claude') === null) {
      console.log(`${dim('not run')}  claude is not on the PATH: ${PLUGIN_INSTALL.join(' ')}`)
    }
    else {
      const ran = await host.run(PLUGIN_INSTALL)

      if (ran.code !== 0)
        console.error(`${red('failed')}   ${PLUGIN_INSTALL.join(' ')}: exit ${ran.code}: ${firstLine(ran.stderr || ran.stdout)}`)
    }
  }

  if (removing.packages.length > 0) {
    const ran = await host.run(uninstall)

    if (ran.code !== 0) {
      console.error(`${red('failed')}   bun remove -g: exit ${ran.code}: ${firstLine(ran.stderr || ran.stdout)}`)

      return 1
    }
  }

  if (removing.plugin && host.which('claude') === null) {
    console.error(`${yellow('not run')}  ${PLUGIN_UNINSTALL.join(' ')}: claude is not on PATH`)
  }
  else if (removing.plugin) {
    const ran = await host.run(PLUGIN_UNINSTALL)

    if (ran.code !== 0) {
      console.error(`${red('failed')}   ${PLUGIN_UNINSTALL.join(' ')}: exit ${ran.code}: ${firstLine(ran.stderr || ran.stdout)}`)

      return 1
    }
  }

  console.log('\nafter the install:')

  const code = await recheck(checksFor(planned.packages, planned.plugin))

  return planned.blocked.length > 0 ? 1 : code
}
