import type { ExitRow, Ran } from '@kaynooo/cli-kit'
import type { Kind } from '../consumers'
import type { Fetcher } from '../registry'
import process from 'node:process'
import { fail, jsonOption, ok, parse, printJson, problem, runCommand, warn, wholeNumber } from '@kaynooo/cli-kit'
import { DEFAULT_MIN_AGE_DAYS } from '../analyze'
import { loadConfigs, loadSettings } from '../config'
import { addCommand } from '../consumers'
import { detectManager } from '../manager'
import { checkPackage, render } from './check'

const usage = `pkg add <name>[@version]... [-D] [--optional] [--peer] [--no-exact] [--force] [--dry-run]

Checks each npm package as \`pkg check\` does, pins its safe version (at least --min-age days old) unless a version was specified, and installs it with the folder's detected package manager (bun, pnpm, yarn, or npm) using exact versions by default.
Blocked packages stop before anything is installed unless --force is given.`

const EXITS: ExitRow[] = [[0, 'every package passed and was installed (or planned with --dry-run)'], [1, 'a package is blocked or the package manager failed'], [2, 'the registry could not be reached or a usage error']]

const options = {
  'dev': { type: 'boolean', short: 'D', description: 'add to devDependencies' },
  'optional': { type: 'boolean', short: 'O', description: 'add to optionalDependencies' },
  'peer': { type: 'boolean', description: 'add to peerDependencies' },
  'exact': { type: 'boolean', default: true, description: 'pin exact versions (default true, --no-exact for range)' },
  'force': { type: 'boolean', description: 'install even when a package is blocked by safety checks' },
  'dry-run': { type: 'boolean', description: 'check and print the install command without running it' },
  'min-age': { type: 'string', description: `days a version must be old (${DEFAULT_MIN_AGE_DAYS}, or the minAge setting)` },
  'json': jsonOption('{manager, installed, command, reports}'),
} as const

export interface AddContext {
  cwd?: string | undefined
  fetcher?: Fetcher | undefined
  now?: number | undefined
  run?: ((argv: string[], cwd: string) => Promise<Ran>) | undefined
}

function kindFromFlags(values: { dev?: boolean | undefined, optional?: boolean | undefined, peer?: boolean | undefined }): Kind {
  if (values.dev === true)
    return 'devDependencies'

  if (values.optional === true)
    return 'optionalDependencies'

  return values.peer === true ? 'peerDependencies' : 'dependencies'
}

export async function add(args: string[], testContext: AddContext = {}): Promise<number> {
  const { values, positionals } = parse(args, usage, options, { allowNegative: true, positionals: ['<name>...'], exits: EXITS })

  if (positionals.length === 0)
    fail(`a package name is needed\n\n${usage}`)

  const cwd = testContext.cwd ?? process.cwd()
  const settings = await loadSettings(cwd)
  const configs = await loadConfigs(cwd)
  const minAgeDays = wholeNumber(values['min-age'], 'min-age', settings.minAge ?? DEFAULT_MIN_AGE_DAYS, 0)
  const rawReports = await Promise.all(positionals.map(async text => checkPackage(text, { configs, settings, minAgeDays, fetcher: testContext.fetcher, now: testContext.now })))
  // When no specific version was requested and latest is only too fresh, fall back to vetting the safe version directly.
  const reports = await Promise.all(rawReports.map(async (report) => {
    if (report.blocked && report.exists && report.requested === undefined && report.safe !== undefined)
      return checkPackage(`${report.name}@${report.safe.version}`, { configs, settings, minAgeDays, fetcher: testContext.fetcher, now: testContext.now })

    return report
  }))
  const blocked = reports.filter(report => report.blocked)

  if (blocked.length > 0 && values.force !== true) {
    if (values.json === true) {
      printJson({ manager: detectManager(cwd), installed: false, command: [], reports })
    }
    else {
      console.log(reports.map(report => render(report)).join('\n\n'))
      problem('pkg add', `${blocked.map(each => each.name).join(', ')} blocked; pass --force to install anyway`)
    }

    return 1
  }

  const detected = detectManager(cwd)
  const jsManager = detected === 'pnpm' || detected === 'yarn' || detected === 'npm' ? detected : 'bun'
  const kind = kindFromFlags(values)
  const exact = values.exact !== false
  const specs: string[] = []

  for (const report of reports) {
    const chosen = report.requested === undefined ? (report.safe?.version ?? report.version) : report.version

    if (chosen === undefined)
      fail(`no installable version found for ${report.name}`, 1)

    if (values.json !== true) {
      for (const warning of report.warnings)
        warn(report.name, warning)
    }

    specs.push(exact ? `${report.name}@${chosen}` : `${report.name}@^${chosen}`)
  }

  // Build single command for all packages using consumers' manager-aware addCommand shape.
  const baseCmd = addCommand({ dir: '.', path: '', kind, spec: '', manager: jsManager }, '__placeholder__', '0.0.0')
  const prefixFlags = baseCmd.slice(0, -1).filter(arg => exact || (arg !== '--exact' && arg !== '--save-exact'))
  const argv = [...prefixFlags, ...specs]

  if (values['dry-run'] === true) {
    if (values.json === true)
      printJson({ manager: jsManager, installed: false, dryRun: true, command: argv, reports })
    else
      console.log(`would run: ${argv.join(' ')}`)

    return 0
  }

  const run = testContext.run ?? (async (cmd, dir) => runCommand(cmd, { cwd: dir }))
  const ran = await run(argv, cwd)

  if (values.json === true) {
    printJson({ manager: jsManager, installed: ran.code === 0, command: argv, reports })

    return ran.code === 0 ? 0 : 1
  }

  if (ran.code !== 0) {
    problem(argv.join(' '), ran.text.trim().split('\n').at(-1) ?? `exit ${ran.code}`)

    return 1
  }

  ok('installed', specs.join(', '))

  return 0
}
