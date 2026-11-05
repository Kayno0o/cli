import type { Ran } from '@kaynooo/cli-kit'
import type { PkgSettings, RegistryConfig } from '../config'
import type { Fetcher, Packument, Registry } from '../registry'
import { existsSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { duration, Exit, fail, formatDuration, formatElapsed, isInteractive, note, ok, parse, problem, runCommand, warn, wholeNumber, workspaceRoot } from '@kaynooo/cli-kit'
import { liveRegion } from '@kaynooo/cli-kit/progress'
import { checklist, confirm } from '@kaynooo/cli-kit/prompt'
import { counted } from '@kaynooo/utils'
import { loadConfigs, loadSettings, registryFor } from '../config'
import { addCommand, findConsumers, isLocal, RANGE_PREFIX, similarDependencies, wantedVersion } from '../consumers'
import { loadExcluded, saveExcluded } from '../excluded'
import { fetchPackument, isValidName } from '../registry'
import { EXACT_VERSION } from '../semver'
import { checkPackage } from './check'

const usage = `pkg bump <name> [version]

Waits until the registry serves the version (the latest when none is given, an exact version otherwise), vets it as \`pkg check\` does (advisories, licence allowlist, and a minimum age only when --min-age asks for one), then runs \`bun add --exact --no-cache\` in each folder under --root whose package.json depends on the package, the kind of dependency kept, a line per folder.
A version the vetting blocks is refused before any folder is touched, unless --force is given.
A dependency declared through an alias of the package (\`"kay": "npm:@kaynooo/kayjs@~1.77.0"\`) is bumped under its own key, keeping the \`~\` or \`^\` of its range; --only and --except narrow the folders by name or glob (\`app\`, \`kay-*\`, a path relative to --root).
A dependency that is not a registry version (workspace:, link:, file:, git, a URL, an npm: alias of another package, catalog:), a peer range, a folder already on the version and one whose lockfile pins another manager are left as they are, each said so.
On a terminal with no --only or --except, a checklist asks which consumers to bump (those left out last time are unchecked, and what is unchecked is remembered in ~/.config/kaynooo-cli/pkg-excluded.json), then the plan is printed and confirmed; --yes skips both, as a pipe or --dry-run does.
With --all-consumers a folder whose package.json or lockfile already has uncommitted changes is left alone, and each folder whose install went through then runs its own \`check\` (the check bin) and is committed with \`gc 'chore(deps): bump <name> to <version>' -- package.json <lockfile>\` only when that passes; a failing one is left uncommitted and listed in the summary with the skipped ones, and nothing is ever pushed.

Exits 0 when every install ran or was left as it is (with --all-consumers, and every check passed and every commit landed), 1 when the vetting refuses the version, an install, a check or a commit fails or the registry has no such package, 2 when the version never shows within the timeout (a registry that cannot be reached is retried until then) or on a usage error.`

export const ROOT_OPTION = { type: 'string', description: 'the folder holding the repositories (the workspace of the user config or KAYNOOO_WORKSPACE, ~/Workspace by default)' } as const

const options = {
  'root': ROOT_OPTION,
  'timeout': { type: 'string', short: 't', description: 'how long to wait for the registry (10m): 30s, 5m, 1h' },
  'all-consumers': { type: 'boolean', description: 'after each install run the folder\'s check and commit it through gc when it passes' },
  'only': { type: 'string', multiple: true, description: 'bump only the folders matching this name or glob, repeatable' },
  'except': { type: 'string', multiple: true, description: 'leave the folders matching this name or glob alone, repeatable' },
  'dry-run': { type: 'boolean', description: 'print what would run, changing nothing' },
  'yes': { type: 'boolean', short: 'y', description: 'on a terminal, bump every consumer without the checklist and the confirmation' },
  'force': { type: 'boolean', description: 'bump even when the version is blocked by the vetting' },
  'min-age': { type: 'string', description: 'days a version must be old (0: a bump adopts a release on purpose, often one just made)' },
} as const

const POLL = 5000

export interface BumpSettings {
  root: string
  configs: RegistryConfig[]
  timeout: number
  isDryRun?: boolean
  // Whether each installed folder is checked and committed.
  isAll?: boolean
  fetcher?: Fetcher | undefined
  // The pkg config the vetting reads, and the minimum age it applies.
  pkgSettings?: PkgSettings | undefined
  minAgeDays?: number | undefined
  isForced?: boolean
  // Folders by name or glob: only these when given, never those of `except`.
  only?: readonly string[] | undefined
  except?: readonly string[] | undefined
  // Folders the user unchecked in the plan: left out, and counted apart from --only and --except.
  declined?: readonly string[] | undefined
  run?: (argv: string[], cwd: string) => Promise<Ran>
  poll?: number
}

// One registry lookup, a transient failure (a network error, a 5xx, a page that is not JSON) returned as an error to try again rather than thrown.
async function lookup(name: string, registry: Registry, fetcher: Fetcher | undefined): Promise<{ packument: Packument | undefined } | { error: string }> {
  try {
    return { packument: await fetchPackument(name, registry, fetcher) }
  }
  catch (error) {
    if (error instanceof Exit && error.code === 2)
      return { error: error.message }

    throw error
  }
}

// The version once the registry serves it, the latest when none is asked for; ends the command when it never does, at once when the registry has no such package.
export async function servedVersion(name: string, version: string | undefined, settings: BumpSettings): Promise<string> {
  if (!isValidName(name))
    fail(`${name} is not a valid npm package name`)

  if (version !== undefined && !EXACT_VERSION.test(version))
    fail(`bump takes an exact version, not ${version}: leave it out for the latest`)

  const registry = registryFor(name, settings.configs)
  const host = new URL(registry.url).host
  const started = Date.now()
  const region = liveRegion(spinner => [`${spinner} waiting for ${host} to serve ${name}@${version ?? 'latest'} ${formatElapsed(Date.now() - started)}`])

  let lastError = ''

  try {
    for (;;) {
      const looked = await lookup(name, registry, settings.fetcher)

      if ('error' in looked) {
        lastError = looked.error
      }
      else {
        const latest = looked.packument?.['dist-tags']?.latest

        if (looked.packument === undefined)
          fail(`${host} has no ${name}`, 1)

        if (version === undefined && latest === undefined)
          fail(`${host} has no ${name}`, 1)

        if (version === undefined && latest !== undefined)
          return latest

        if (version !== undefined && looked.packument.versions?.[version] !== undefined)
          return version
      }

      if (Date.now() - started >= settings.timeout)
        fail(`${host} does not serve ${name}@${version ?? 'latest'} after ${formatDuration(settings.timeout)}${lastError === '' ? '' : `, last error: ${lastError}`}`)

      region.redraw()
      await Bun.sleep(settings.poll ?? POLL)
    }
  }
  finally {
    region.stop()
  }
}

// Runs on the version the checks `pkg check` runs before an add, saying why it is refused; true when it may go in or --force was given.
export async function vet(name: string, version: string, settings: BumpSettings): Promise<boolean> {
  if (settings.isForced === true)
    return true

  const report = await checkPackage(`${name}@${version}`, { configs: settings.configs, fetcher: settings.fetcher, minAgeDays: settings.minAgeDays ?? 0, settings: settings.pkgSettings })

  if (!report.blocked) {
    for (const warning of report.warnings)
      warn(`${name}@${version}`, warning)

    return true
  }

  for (const warning of report.warnings)
    problem(`${name}@${version} is refused`, warning)

  problem(`${name}@${version} is refused`, 'no consumer was touched, --force bumps it anyway')

  return false
}

// The lockfile of the folder, which a monorepo keeps at its root, as a path relative to the folder; undefined when there is none.
export function lockfileOf(dir: string, root: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    const found = ['bun.lock', 'bun.lockb'].find(file => existsSync(join(at, file)))

    if (found !== undefined)
      return relative(dir, join(at, found))

    if (at === root || at === dirname(at))
      return undefined
  }
}

// Whether the folder's package.json or lockfile already differs from git, which the commit of the bump would carry along.
async function hasUncommittedChanges(where: string, root: string, run: NonNullable<BumpSettings['run']>): Promise<boolean> {
  const lockfile = lockfileOf(where, root)
  const status = await run(['git', 'status', '--porcelain', '--', 'package.json', ...lockfile === undefined ? [] : [lockfile]], where)

  return status.code === 0 && status.text.trim() !== ''
}

// Runs a folder's check then commits its bump, returning why it stopped, undefined once committed.
export async function checkAndCommit(name: string, version: string, where: string, root: string, run: NonNullable<BumpSettings['run']>): Promise<string | undefined> {
  const checked = await run(['check'], where)

  if (checked.code !== 0)
    return `check exited ${checked.code}: ${checked.text.trim().split('\n').at(-1) ?? ''}`

  const lockfile = lockfileOf(where, root)
  const committed = await run(['gc', `chore(deps): bump ${name} to ${version}`, '--', 'package.json', ...lockfile === undefined ? [] : [lockfile]], where)

  return committed.code === 0 ? undefined : `gc exited ${committed.code}: ${committed.text.trim().split('\n').at(-1) ?? ''}`
}

// A test for whether a folder (relative to the root) is named by one of the patterns, as a whole path or by its last segment.
function matcher(patterns: readonly string[]): (dir: string) => boolean {
  const globs = patterns.map(pattern => new Bun.Glob(pattern))

  return dir => globs.some(glob => glob.match(dir) || glob.match(basename(dir)))
}

// Puts the version in every consumer under the root, returning whether every install went through and, with isAll, every check passed and every commit landed.
export async function bumpConsumers(name: string, version: string, settings: BumpSettings): Promise<boolean> {
  const everyone = findConsumers(name, settings.root)
  const isOnly = matcher(settings.only ?? [])
  const isExcept = matcher(settings.except ?? [])
  const declined = new Set(settings.declined ?? [])
  const found = everyone.filter(each => (settings.only === undefined || settings.only.length === 0 || isOnly(each.dir)) && !isExcept(each.dir) && !declined.has(each.dir))
  const consumers = found.filter(each => !isLocal(each))
  const left = everyone.length - found.length - declined.size
  const local = found.length - consumers.length
  const run = settings.run ?? (async (argv, cwd) => runCommand(argv, { cwd }))
  const committed: string[] = []
  const failing: string[] = []
  const skipped: string[] = []
  let isClean = true

  if (everyone.length === 0) {
    const similar = similarDependencies(name, settings.root)

    note(`nothing under ${settings.root} depends on ${name}`, similar.length === 0 ? undefined : `did you mean ${similar.join(', ')}`)
  }
  else if (left > 0) {
    note(`${counted(left, 'folder')} left out by --only or --except`)
  }

  if (declined.size > 0)
    note(`${counted(declined.size, 'folder')} left out by your choice`)

  // a monorepo's own packages take it from the workspace, one line saying so for all of them
  if (local > 0)
    note(`${local} non-registry dependenc${local === 1 ? 'y' : 'ies'} (workspace:, file:, git, URL, alias, catalog:)`, 'left as they are')

  for (const consumer of consumers) {
    const argv = addCommand(consumer, name, version)
    const where = join(settings.root, consumer.dir)

    if (consumer.kind === 'peerDependencies') {
      skipped.push(consumer.dir)
      note(consumer.dir, `peer range ${consumer.spec}, left as it is`)
    }
    else if ((consumer.alias === undefined ? consumer.spec : wantedVersion(consumer).replace(RANGE_PREFIX, '')) === version) {
      skipped.push(consumer.dir)
      note(consumer.dir, `already on ${version}`)
    }
    else if (consumer.manager !== 'bun') {
      skipped.push(consumer.dir)
      warn(consumer.dir, `${consumer.spec}, its lockfile pins ${consumer.manager}: put ${version} in by hand`)
    }
    else if (settings.isDryRun === true) {
      note(consumer.dir, `would run ${[argv.join(' '), ...settings.isAll === true ? ['check', `gc 'chore(deps): bump ${name} to ${version}'`] : []].join(', then ')}`)
    }
    else if (settings.isAll === true && await hasUncommittedChanges(where, settings.root, run)) {
      isClean = false
      failing.push(consumer.dir)
      problem(consumer.dir, 'package.json or its lockfile has uncommitted changes, left alone so that gc does not commit them')
    }
    else {
      const ran = await run(argv, where)

      if (ran.code !== 0) {
        isClean = false
        failing.push(consumer.dir)
        problem(consumer.dir, `${argv.join(' ')} exited ${ran.code}: ${ran.text.trim().split('\n').at(-1) ?? ''}`)
      }
      else if (settings.isAll !== true) {
        ok(consumer.dir, `${consumer.spec} -> ${version}`)
      }
      else {
        const failure = await checkAndCommit(name, version, where, settings.root, run)

        if (failure === undefined) {
          committed.push(consumer.dir)
          ok(consumer.dir, `${consumer.spec} -> ${version}, checked and committed`)
        }
        else {
          isClean = false
          failing.push(consumer.dir)
          problem(consumer.dir, `${consumer.spec} -> ${version}, left uncommitted: ${failure}`)
        }
      }
    }
  }

  if (settings.isAll === true && settings.isDryRun !== true)
    note('summary', `${committed.length} bumped and committed, ${failing.length} bumped and failing${failing.length > 0 ? ` (${failing.join(', ')})` : ''}, ${skipped.length + local} skipped`)

  return isClean
}

export interface Plan {
  dir: string
  line: string
}

// The folders a bump would touch, each as the line the plan prints: the ones a bump leaves as they are (peer ranges, already on the version, local specs, another manager's lockfile) are not offered.
export function plannedBumps(name: string, version: string, settings: BumpSettings): Plan[] {
  return findConsumers(name, settings.root)
    .filter(each => !isLocal(each) && each.kind !== 'peerDependencies' && each.manager === 'bun' && (each.alias === undefined ? each.spec : wantedVersion(each).replace(RANGE_PREFIX, '')) !== version)
    .map(each => ({ dir: each.dir, line: `${each.dir}  ${each.spec} -> ${version}` }))
}

export interface Chooser {
  pick: (name: string, plans: Plan[], excluded: ReadonlySet<string>) => Promise<ReadonlySet<string> | undefined>
  confirm: (question: string) => Promise<boolean | undefined>
}

const terminalChooser: Chooser = {
  pick: async (name, plans, excluded) => checklist(`bump ${name} in`, plans.map(plan => ({ value: plan.dir, label: plan.line, hint: excluded.has(plan.dir) ? 'left out last time' : '' })), { initial: new Set(plans.filter(plan => !excluded.has(plan.dir)).map(plan => plan.dir)), hint: 'pass --yes to bump every consumer' }),
  confirm: async question => confirm(question, { default: true }),
}

// Asks which of the consumers to bump, the ones left out last time unchecked, remembers what is unchecked now and prints the plan for a yes; the folders to bump and those left out, none to bump when declined, undefined when there is nothing to choose from.
export async function choosePlan(name: string, version: string, settings: BumpSettings, chooser: Chooser = terminalChooser, home?: string): Promise<{ chosen: string[], declined: string[] } | undefined> {
  const plans = plannedBumps(name, version, settings)

  if (plans.length === 0)
    return undefined

  const excluded = new Set(loadExcluded(home)?.[name] ?? [])
  const picked = await chooser.pick(name, plans, excluded)

  if (picked === undefined)
    return { chosen: [], declined: plans.map(plan => plan.dir) }

  const chosen = plans.filter(plan => picked.has(plan.dir))

  for (const plan of chosen)
    note('plan', plan.line)

  // What is unchecked is kept once the plan is confirmed, so a cancelled run changes nothing.
  if (chosen.length === 0 || await chooser.confirm(`bump ${name} to ${version} in ${counted(chosen.length, 'folder')}?`) !== true)
    return { chosen: [], declined: plans.map(plan => plan.dir) }

  const declined = plans.filter(plan => !picked.has(plan.dir)).map(plan => plan.dir)

  saveExcluded(name, [...excluded].filter(dir => !plans.some(plan => plan.dir === dir)).concat(declined), home)

  return { chosen: chosen.map(plan => plan.dir), declined }
}

export async function bump(args: string[]): Promise<number> {
  const { values, positionals: [name, asked] } = parse(args, usage, options, { positionals: ['<name>', '[version]'] })
  const settings: BumpSettings = {
    root: workspaceRoot({ given: values.root }),
    configs: await loadConfigs(),
    timeout: duration(values.timeout, 'timeout', 10 * 60_000),
    isDryRun: values['dry-run'] === true,
    isAll: values['all-consumers'] === true,
    isForced: values.force === true,
    only: values.only,
    except: values.except,
    pkgSettings: await loadSettings(),
    minAgeDays: wholeNumber(values['min-age'], 'min-age', 0, 0),
  }
  const version = await servedVersion(name, asked, settings)

  if (!await vet(name, version, settings))
    return 1

  // On a terminal with no folder named, the user picks which consumers and confirms the plan; --yes and a pipe keep bumping every one.
  if (settings.isDryRun !== true && values.yes !== true && isInteractive() && (settings.only?.length ?? 0) === 0 && (settings.except?.length ?? 0) === 0) {
    const plan = await choosePlan(name, version, settings)

    if (plan?.chosen.length === 0) {
      note('nothing to bump', 'none chosen or not confirmed')

      return 0
    }

    settings.declined = plan?.declined
  }

  return await bumpConsumers(name, version, settings) ? 0 : 1
}
