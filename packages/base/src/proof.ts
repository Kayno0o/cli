import type { ExitRow } from '@kaynooo/cli-kit'
import type { Run } from './worktree'
import process from 'node:process'
import { exitCodeOf, fail, holdSignals, jsonOption, parse, printJson, wholeNumber } from '@kaynooo/cli-kit'
import { checkout, defaultProofRef, folded, inWorktree, keptPaths, resolveRef, runIn, runsInContainer, shellCommand } from './worktree'

const USAGE = 'proof [--ref <rev>] [--runs <n>] [--keep <path>...] [--no-link] [--json] -- <command> [args...]: runs the command at HEAD or another ref in a temporary worktree, then in the working tree, to show that a test fails before a change and passes after it\n\nThe ref defaults to the merge base with origin/main when HEAD is on a branch ahead of it, else HEAD. --runs <n> runs the command n times now, for a flaky test, and every run must pass.'

const EXITS: ExitRow[] = [[0, 'the command fails before and passes in every run now'], [1, 'it passes before too, fails in any run now, or passes before and fails now'], [2, 'a usage error, an unknown ref, a command that cannot start or ends with exit 126, 127 or a signal'], [130, 'interrupted (128 plus the signal)']]

const OPTIONS = {
  'ref': { type: 'string', short: 'r', description: 'the commit to run before at (default: the merge base with origin/main on a branch ahead of it, else HEAD)' },
  'runs': { type: 'string', short: 'n', description: 'run the command this many times now, every run must pass (1)' },
  'keep': { type: 'string', short: 'k', multiple: true, description: 'a working-tree file or folder copied over to the ref, such as the new test, repeatable' },
  'no-link': { type: 'boolean', description: 'do not link the ignored env files, node_modules, vendor and .venv of the checkout' },
  'json': jsonOption('{outcome, proved, ref, sha, before: {code, output}, now: {code, output}}'),
} as const

// A shell's "not executable", "not found" and killed-by-signal codes say the command did not run, which no test result does.
function abnormal(code: number): boolean {
  return code === 126 || code === 127 || (code > 128 && code < 160)
}

type Outcome = 'proved' | 'passes-before' | 'fails-both' | 'regressed' | 'flaky'

function outcomeOf(before: number, now: readonly number[]): Outcome {
  const failed = now.filter(code => code !== 0).length

  if (before !== 0 && failed === 0)
    return 'proved'

  if (before === 0 && failed === 0)
    return 'passes-before'

  if (before !== 0)
    return failed < now.length ? 'flaky' : 'fails-both'

  return 'regressed'
}

// The message of each outcome and the side whose output explains it.
function describe(outcome: Outcome, at: string, now: readonly number[]): { message: string, side: 'before' | 'now' } {
  switch (outcome) {
    case 'proved': return { message: now.length > 1 ? `fails at ${at}, passes now in ${now.length} of ${now.length} runs` : `fails at ${at}, passes now`, side: 'before' }
    case 'passes-before': return { message: `passes at ${at} too: it does not fail without the change`, side: 'before' }
    case 'fails-both': return { message: `fails at ${at} and fails now too`, side: 'now' }
    case 'regressed': return { message: `passes at ${at}, fails now`, side: 'now' }
    case 'flaky': return { message: `fails at ${at}, but ${now.filter(code => code !== 0).length} of ${now.length} runs fail now`, side: 'now' }
  }
}

export async function proof(argv: string[]): Promise<number> {
  // Bun drops a leading `--` before the script sees it, so a first word that is no option starts the command.
  const bare = argv[0] !== undefined && !argv[0].startsWith('-')
  const parsed = parse(bare ? [] : argv, USAGE, OPTIONS, { rest: true, exits: EXITS, replaces: 'running a test, stashing the change and running it again', examples: [['proof --keep tests/fix.test.ts -- bun test tests/fix.test.ts', 'the new test fails at HEAD and passes now'], ['proof --ref v1.2.0 --keep tests/fix.test.ts -- bun test tests/fix.test.ts', 'the same against a release']] })

  const given = bare ? argv : parsed.rest ?? []

  if (given.length === 0 || parsed.positionals.length > 0)
    fail(`give the command after --\n\n${USAGE}`)

  if (runsInContainer(given))
    fail('a container of the compose project mounts the main checkout, not the temporary worktree, so the command would not run at the ref: run the tool on the host, or check the ref out by hand')

  const command = shellCommand(given)
  const cwd = process.cwd()
  const { root, prefix } = await checkout(cwd)
  const runs = wholeNumber(parsed.values.runs, 'runs', 1, 1)
  const ref = parsed.values.ref ?? await defaultProofRef(root)
  const sha = await resolveRef(root, ref)
  const kept = keptPaths(root, cwd, parsed.values.keep ?? [])

  const signals = holdSignals()
  let before: Run
  const nowRuns: Run[] = []

  try {
    before = await inWorktree({ root, prefix, sha, ref, kept, link: parsed.values['no-link'] !== true, signals }, async (runDir, held) => runIn(runDir, command, held, true))

    for (let i = 0; i < runs && signals.signal === undefined; i++)
      nowRuns.push(await runIn(cwd, command, signals, true))
  }
  finally {
    signals.release()
  }

  if (signals.signal !== undefined || nowRuns.length < runs)
    return exitCodeOf(null, signals.signal ?? null)

  for (const [run, where] of [[before, `at ${sha.slice(0, 7)}`], ...nowRuns.map((each, i) => [each, runs > 1 ? `now (run ${i + 1})` : 'now'] as const)] as const) {
    if (!run.started)
      fail(run.output)

    if (abnormal(run.code))
      fail(`the command did not run properly ${where}: exit ${run.code}, a missing command or a kill, not a test result${run.output.trim() === '' ? '' : `\n\n${folded(run.output)}`}`)
  }

  const codes = nowRuns.map(run => run.code)
  const now = nowRuns.find(run => run.code !== 0) ?? nowRuns.at(-1) ?? before
  const outcome = outcomeOf(before.code, codes)
  const { message, side } = describe(outcome, sha.slice(0, 7), codes)
  const proved = outcome === 'proved'

  if (parsed.values.json === true) {
    printJson({ outcome, proved, ref, sha, before: { code: before.code, output: before.output }, now: { code: now.code, output: now.output }, runs: nowRuns.map(run => ({ code: run.code })) })

    return proved ? 0 : 1
  }

  console.log(message)

  if (runs > 1)
    console.log(`now: ${codes.map((code, i) => `run ${i + 1} ${code === 0 ? 'passed' : `failed (exit ${code})`}`).join(', ')}`)

  const shown = side === 'before' ? before : now

  if (shown.code !== 0 && shown.output.trim() !== '')
    console.log(`\n${folded(shown.output)}`)

  return proved ? 0 : 1
}
