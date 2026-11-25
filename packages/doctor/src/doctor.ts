import type { ExitRow } from '@kaynooo/cli-kit'
import type { Host, Result } from './checks'
import type { Outcome } from './fix'
import process from 'node:process'
import { jsonOption, marked, paint, parse, printHeader, printJson, writeErr } from '@kaynooo/cli-kit'
import { CHECK_NAMES, isInstalled, runChecks, TOOLS } from './checks'
import { convergeFixes } from './fix'
import { hostHere } from './host'

const USAGE = `cli doctor [--only <check>] [--quiet] [--fix] [--dry-run] [--offline] [--json]: checks this host's @kaynooo/cli-* install, one line per check with the fix beside a failing one

Checks the installed packages are current, their system tools, tea's login, the Claude Code hooks, Bun, the shell completions (fish files, or the script a bash or zsh rc sources), dead bin links and the commands dl installed; a package not installed is no failure.
--fix runs the printed fixes in passes until everything converges (cleaning dead bin links and refreshing completions after package upgrades); a fix that installs a system package or only describes a step is printed, never run.
To install or remove packages, use \`cli add\`, \`cli remove\` or \`cli manage\`.`

const EXITS: ExitRow[] = [[0, 'every check passes (after --fix, the ones it fixed too)'], [1, 'a check fails'], [2, 'a usage error']]

const INSTALL = 'bun install -g '

const OPTIONS = {
  'json': jsonOption('[{check, ok, detail, fix?}], as the checks stand after --fix; the fixes it ran go to stderr'),
  'only': { type: 'string', multiple: true, choices: CHECK_NAMES, description: 'run only this check (a package such as cli-forge, tea, hooks, bun or completions), repeatable' },
  'quiet': { type: 'boolean', short: 'q', description: 'print only the failing checks' },
  'offline': { type: 'boolean', description: 'skip registry and remote release lookups' },
  'fix': { type: 'boolean', description: 'run the fix: lines doctor may run, then check again' },
  'dry-run': { type: 'boolean', description: 'show what --fix would run without running it (implies --fix)' },
} as const

export function printResults(results: readonly Result[], { header = true, showFix = true, showBatch = true }: { header?: boolean, showFix?: boolean, showBatch?: boolean } = {}): void {
  if (results.length === 0)
    return

  if (header)
    printHeader('cli doctor', `${results.length} ${results.length === 1 ? 'check' : 'checks'}`)

  const { dim } = paint(process.stdout)
  const width = Math.max(...results.map(result => result.check.length))

  for (const { check, ok, warn, detail, fix } of results) {
    let mark: 'ok' | 'warn' | 'problem' = 'ok'

    if (!ok)
      mark = 'problem'
    else if (warn === true)
      mark = 'warn'

    const suffix = showFix && fix !== undefined ? `  ${dim('fix:')} ${fix}` : ''

    console.log(marked(mark, `${check.padEnd(width)}  ${detail}${suffix}`, process.stdout))
  }

  if (!showBatch)
    return

  const installs = results.flatMap(result => result.fix?.startsWith(INSTALL) === true ? [result.fix.slice(INSTALL.length)] : [])

  if (installs.length > 1)
    console.log(`\n${dim('fix them all:')} ${INSTALL}${installs.join(' ')}`)
}

export function printOutcome({ command, status, detail }: Outcome, log: (line: string) => void): void {
  const { green, red, dim } = paint(process.stdout)
  const marks = { 'ran': green('ran    '), 'failed': red('failed '), 'dry-run': dim('would  '), 'not run': dim('not run') }

  log(`${marks[status]}  ${command}${detail === undefined ? '' : `  ${dim(detail)}`}`)
}

export async function main(args: string[], host: Host = hostHere()): Promise<number> {
  const { values } = parse(args, USAGE, OPTIONS, { positionals: [], exits: EXITS, replaces: 'checking each bin\'s version, tea\'s login and the hooks by hand', examples: ['cli doctor', ['cli doctor --json', 'the checks for a script'], ['cli doctor -q', 'silent unless something fails'], ['cli doctor --fix --dry-run', 'what --fix would run'], ['cli doctor --fix', 'run safe fixes and re-check']] })
  const only = values.only ?? []
  const dry = values['dry-run'] === true
  const json = values.json === true
  const offline = values.offline === true
  const registryCache = new Map<string, string>()
  let results = await runChecks(host, only, { offline, registryCache })
  let fixed = false
  let touched = new Set<string>()

  if ((values.fix === true || dry) && results.some(result => !result.ok)) {
    if (!json)
      printResults(results.filter(result => !result.ok), { showBatch: false })

    const log = json ? writeErr : console.log
    const run = await convergeFixes(host, results, async () => runChecks(host, only, { offline, registryCache }), { dry, onOutcome: outcome => printOutcome(outcome, log) })

    if (dry)
      return 1

    results = run.results
    touched = run.touched
    fixed = run.changed

    if (!fixed) {
      if (json)
        printJson(values.quiet === true ? results.filter(result => !result.ok) : results)

      return results.every(result => result.ok) ? 0 : 1
    }
  }

  let shown = results

  if (values.quiet === true)
    shown = results.filter(result => !result.ok)
  else if (fixed && !json)
    shown = results.filter(result => touched.has(result.check) || !result.ok)

  if (fixed && !json && shown.length > 0)
    console.log('\nafter the fixes:')

  if (json)
    printJson(shown)
  else
    printResults(shown)

  const absent = Object.keys(TOOLS).filter(name => !isInstalled(host, name)).length

  if (!json && only.length === 0 && absent > 0)
    console.log(`\n${paint(process.stdout).dim(`${absent} packages not installed: cli add <name> or cli manage`)}`)

  return results.every(result => result.ok) ? 0 : 1
}
