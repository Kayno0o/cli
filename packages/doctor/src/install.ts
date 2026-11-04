import type { Choice } from '@kaynooo/cli-kit/prompt'
import type { Host } from './checks'
import process from 'node:process'
import { badUsage, paint } from '@kaynooo/cli-kit'
import { checklist } from '@kaynooo/cli-kit/prompt'
import { ABOUT, HOOKS_REQUIRES, NEEDS } from './catalog'
import { firstLine, FORGE, hooksWiring, isInstalled, TOOLS } from './checks'

// What `doctor --install` can add: a package, or the Claude Code hooks plugin that calls guard.
interface Candidate {
  id: string
  // The words typed after --install to name it.
  names: string[]
  label: string
  hint: string
  packages: string[]
}

export interface InstallOptions {
  names: readonly string[]
  list: boolean
  dryRun: boolean
  force: boolean
}

const HOOKS = 'hooks'
const PLUGIN_INSTALL = ['claude', 'plugin', 'install', 'cli-hooks', '--marketplace', `https://${FORGE}/kaynooo/cli.git`]

const CLI_PREFIX = /^cli-/
const shortName = (name: string) => name.slice(name.indexOf('/') + 1).replace(CLI_PREFIX, '')

function candidates(host: Host): Candidate[] {
  const packages = Object.entries(TOOLS).filter(([name]) => !isInstalled(host, name)).map(([name, bins]): Candidate => {
    const needs = (NEEDS[name] ?? []).map(need => `${need.bin}${need.optional === true ? ' (optional)' : ''}`)

    return { id: name, names: [shortName(name), name, `cli-${shortName(name)}`, ...bins], label: shortName(name), hint: `${bins.join(' ')}: ${ABOUT[name] ?? ''}${needs.length === 0 ? '' : `, needs ${needs.join(', ')}`}`, packages: [name] }
  })
  const { plugin, mod } = hooksWiring(host)

  if (plugin || mod !== undefined)
    return packages

  return [...packages, { id: HOOKS, names: [HOOKS, 'plugin', 'cli-hooks'], label: 'hooks', hint: `the Claude Code plugin running guard on every tool call, needs ${HOOKS_REQUIRES}`, packages: isInstalled(host, HOOKS_REQUIRES) ? [] : [HOOKS_REQUIRES] }]
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
    const required = lacking.filter(need => need.optional !== true)

    for (const need of lacking.filter(each => each.optional === true))
      warnings.push({ package: shortName(name), need: need.bin, why: need.why })

    if (required.length > 0 && !force) {
      for (const need of required)
        blocked.push({ package: shortName(name), need: need.bin, why: need.why, how: need.how })

      continue
    }

    for (const need of required)
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

async function ask(pool: readonly Candidate[]): Promise<Candidate[]> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true)
    badUsage('name what to install, or all: doctor --install forgejo check hooks (doctor --install --list shows the choices)')

  const choices: Choice<Candidate>[] = pool.map(each => ({ value: each, label: each.label, hint: each.hint }))
  const picked = await checklist('install which?', choices, { hint: 'name them instead: doctor --install forgejo check' })

  return picked === undefined ? [] : [...picked]
}

// Installs what the user names or picks, refusing a package whose required tool is missing unless --force, then checks and fixes what it installed through `recheck`.
export async function install(host: Host, options: InstallOptions, recheck: (only: string[]) => Promise<number>): Promise<number> {
  const pool = candidates(host)
  const { dim, green, red, yellow } = paint(process.stdout)

  if (options.list) {
    for (const each of pool)
      console.log(`${each.label.padEnd(12)} ${dim(each.hint)}`)

    if (pool.length === 0)
      console.log('everything is installed')

    return 0
  }

  if (pool.length === 0) {
    console.log('everything is installed')

    return 0
  }

  const unknown = options.names.filter(name => name !== 'all' && !Object.values(candidatesAll(host)).some(each => each.names.includes(name)))

  if (unknown.length > 0)
    badUsage(`nothing to install is named ${unknown.join(', ')}: doctor --install --list`)

  const picked = options.names.length === 0 ? await ask(pool) : choose(pool, options.names)
  const skipped = options.names.filter(name => name !== 'all' && !pool.some(each => each.names.includes(name)))

  for (const name of skipped)
    console.log(`${dim('already')}  ${name} is installed`)

  if (picked.length === 0) {
    if (skipped.length === 0)
      console.log('nothing picked')

    return 0
  }

  const planned = plan(host, picked, options.force)

  for (const each of planned.blocked)
    console.log(`${red('blocked')}  ${each.package} needs ${each.need} (${each.why}): ${each.how}; --force installs it anyway`)

  for (const each of planned.warnings)
    console.log(`${yellow('warn   ')}  ${each.package}: ${each.need} is missing, ${each.why}`)

  if (planned.packages.length === 0 && !planned.plugin)
    return 1

  const command = ['bun', 'install', '-g', ...planned.packages]

  if (planned.packages.length > 0)
    console.log(`${options.dryRun ? dim('would  ') : green('install')}  ${command.join(' ')}`)

  if (planned.plugin)
    console.log(`${options.dryRun ? dim('would  ') : green('install')}  ${PLUGIN_INSTALL.join(' ')}`)

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

  console.log('\nafter the install:')

  const code = await recheck(checksFor(planned.packages, planned.plugin))

  return planned.blocked.length > 0 ? 1 : code
}

// Every candidate by any name, installed or not, so a name already installed is told apart from a typo.
function candidatesAll(host: Host): Candidate[] {
  const open = candidates(host)
  const done = Object.entries(TOOLS).filter(([name]) => isInstalled(host, name)).map(([name, bins]): Candidate => ({ id: name, names: [shortName(name), name, `cli-${shortName(name)}`, ...bins], label: shortName(name), hint: '', packages: [name] }))

  return [...open, ...done]
}
