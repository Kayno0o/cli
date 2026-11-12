import process from 'node:process'
import { fail, parse, role } from '@kaynooo/cli-kit'
import { checkout, inWorktree, keptPaths, resolveRef, runIn, runsInContainer, shellCommand } from './worktree'

const USAGE = 'base [--ref <rev>] [--keep <path>...] [--no-link] -- <command> [args...]: runs the command at HEAD or another ref in a temporary worktree, exiting with its code\n\nThe changes of the working tree stay out of the run, but its ignored env files, node_modules, vendor and .venv are linked in, so a write to them lands in the working tree; --no-link runs fully apart.\n\nExits with the code of the command, 127 when it cannot be started, 2 on a usage error, an unknown ref or a refused command.'

const OPTIONS = {
  'ref': { type: 'string', short: 'r', description: 'the commit to run at (default HEAD)' },
  'keep': { type: 'string', short: 'k', multiple: true, description: 'a working-tree file or folder copied over, such as the new test, repeatable' },
  'no-link': { type: 'boolean', description: 'do not link the ignored env files, node_modules, vendor and .venv of the checkout' },
} as const

export async function base(argv: string[]): Promise<number> {
  // Bun drops a leading `--` before the script sees it, so a first word that is no option starts the command.
  const bare = argv[0] !== undefined && !argv[0].startsWith('-')
  const parsed = parse(bare ? [] : argv, USAGE, OPTIONS, { rest: true, replaces: 'git stash, a test run, then git stash pop', examples: [['base -- bun test tests/api.test.ts', 'the test at HEAD, the working tree changes left out'], ['base --ref main~3 --keep tests/new.test.ts -- bun test tests/new.test.ts', 'a new test against an older commit']] })

  const given = bare ? argv : parsed.rest ?? []

  if (given.length === 0 || parsed.positionals.length > 0)
    fail(`give the command after --\n\n${USAGE}`)

  if (runsInContainer(given))
    fail('a container of the compose project mounts the main checkout, not the temporary worktree, so the command would not run at the ref: run the tool on the host, or check the ref out by hand')

  const command = shellCommand(given)
  const cwd = process.cwd()
  const { root, prefix } = await checkout(cwd)
  const ref = parsed.values.ref ?? 'HEAD'
  const sha = await resolveRef(root, ref)
  const kept = keptPaths(root, cwd, parsed.values.keep ?? [])

  const ran = await inWorktree({ root, prefix, sha, ref, kept, link: parsed.values['no-link'] !== true }, async (runDir, signals) => runIn(runDir, command, signals))

  if (!ran.started)
    console.error(`${role('problem', process.stderr)('base:')} ${ran.output}`)

  console.error(`${role('label', process.stderr)('base:')} ran at ${ref} (${sha.slice(0, 7)}), exit ${ran.code}`)

  return ran.code
}
