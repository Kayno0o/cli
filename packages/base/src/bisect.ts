import type { ExitRow } from '@kaynooo/cli-kit'
import process from 'node:process'
import { duration, exitCodeOf, fail, holdSignals, jsonOption, parse, printJson, role, runCommand, writeErr } from '@kaynooo/cli-kit'
import { autoKeptPaths, checkout, inWorktree, keptPaths, resolveRef, runIn, runsInContainer, shellCommand } from './worktree'

const USAGE = `base bisect --good <ref> [--bad <ref>] [--keep <path>...] [--timeout <duration>] [--no-link] [--json] -- <command> [args...]

Non-destructive binary search for the first commit where <command> fails, testing each midpoint in a temporary linked worktree without touching the current checkout.`

const EXITS: ExitRow[] = [[0, 'found the first bad commit'], [1, 'good ref already fails, bad ref passes, or no commit between them'], [2, 'a usage error, unknown ref, or timeout'], [130, 'interrupted (128 plus the signal)']]

const OPTIONS = {
  'good': { type: 'string', short: 'g', description: 'known good commit/tag/branch where the command passes (required)' },
  'bad': { type: 'string', short: 'b', description: 'known bad commit/tag/branch where the command fails (default: HEAD)' },
  'keep': { type: 'string', short: 'k', multiple: true, description: 'a working-tree file or folder copied into each temporary worktree, repeatable' },
  'timeout': { type: 'string', short: 't', description: 'kill a step lasting longer than this (30s, 5m, 1h)' },
  'no-link': { type: 'boolean', description: 'do not link ignored env files, node_modules, vendor and .venv' },
  'json': jsonOption('{firstBad: {sha, subject, author, date}, good, bad, tested: [{sha, code}]}'),
} as const

export async function bisect(argv: string[]): Promise<number> {
  const parsed = parse(argv, USAGE, OPTIONS, { rest: true, exits: EXITS, examples: [['base bisect --good v1.0.0 -- bun test tests/api.test.ts', 'find the exact commit that broke api.test.ts']] })
  const given = parsed.rest ?? []

  if (given.length === 0 || parsed.positionals.length > 0)
    fail(`give the command after --\n\n${USAGE}`)

  if (parsed.values.good === undefined)
    fail(`--good <ref> is required\n\n${USAGE}`)

  if (runsInContainer(given))
    fail('a container of the compose project mounts the main checkout, not the temporary worktree')

  const command = shellCommand(given)
  const cwd = process.cwd()
  const { root, prefix } = await checkout(cwd)
  const goodSha = await resolveRef(root, parsed.values.good)
  const badSha = await resolveRef(root, parsed.values.bad ?? 'HEAD')
  const listRan = await runCommand(['git', 'rev-list', '--first-parent', '--reverse', `${goodSha}..${badSha}`], { cwd: root })

  if (listRan.code !== 0)
    fail(`git rev-list failed: ${listRan.text.trim()}`)

  const commits = listRan.stdout.trim().split('\n').filter(Boolean)

  if (commits.length === 0)
    fail(`no commits between ${goodSha.slice(0, 7)} and ${badSha.slice(0, 7)}`, 1)

  const explicitKept = keptPaths(root, cwd, parsed.values.keep ?? [])
  const autoKept = (await autoKeptPaths(root, cwd, given, goodSha, false)).filter(path => !explicitKept.includes(path))
  const kept = [...explicitKept, ...autoKept]
  const timeoutMs = parsed.values.timeout === undefined ? undefined : duration(parsed.values.timeout, 'timeout', 0)
  const link = parsed.values['no-link'] !== true
  const json = parsed.values.json === true
  const signals = holdSignals()
  const tested: { sha: string, code: number }[] = []

  const testAt = async (sha: string): Promise<number> => {
    const run = await inWorktree({ root, prefix, sha, ref: sha, kept, link, signals }, async (runDir, held) => runIn(runDir, command, held, true, timeoutMs))

    if (!run.started)
      fail(run.output)

    if (run.timedOut === true)
      fail(`command timed out at ${sha.slice(0, 7)}`)

    tested.push({ sha, code: run.code })

    if (!json)
      writeErr(`  ${sha.slice(0, 7)} ${run.code === 0 ? role('ok', process.stderr)('good') : role('problem', process.stderr)('bad')}`)

    return run.code
  }

  try {
    let low = 0
    let high = commits.length - 1

    // Verify endpoints: bad must fail.
    if (await testAt(commits[high]!) === 0)
      fail(`bad ref ${badSha.slice(0, 7)} already passes`, 1)

    while (low < high && signals.signal === undefined) {
      const mid = Math.floor((low + high) / 2)
      const code = await testAt(commits[mid]!)

      if (code === 0)
        low = mid + 1
      else
        high = mid
    }

    if (signals.signal !== undefined)
      return exitCodeOf(null, signals.signal)

    const culprit = commits[low]!
    const infoRan = await runCommand(['git', 'show', '-s', '--format=%H%n%s%n%an%n%aI', culprit], { cwd: root })
    const [sha = culprit, subject = '', author = '', date = ''] = infoRan.stdout.trim().split('\n')

    if (json) {
      printJson({ firstBad: { sha, subject, author, date }, good: goodSha, bad: badSha, tested })
    }
    else {
      console.log(`${role('problem', process.stdout)('first bad commit:')} ${sha.slice(0, 7)} ${subject}`)
      console.log(`  author: ${author} (${date}) · ${tested.length} step${tested.length === 1 ? '' : 's'}`)
    }

    return 0
  }
  finally {
    signals.release()
  }
}
