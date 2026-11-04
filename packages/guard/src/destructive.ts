import { parseCommand, SHELLS, splitCommand } from '@kaynooo/cli-kit/shell'
import { isWholeTree, subcommandOf } from './git'

const FETCHERS = new Set(['curl', 'wget', 'fetch'])
// Programs that run the text they are given as commands.
const EVALUATORS = new Set(['eval', 'source', '.'])
const FETCH_SUBSTITUTION = /(?:\$\(|<\(|`)\s*(?:curl|wget|fetch)\b/
const SHORT_CLUSTER = /^-[A-Z]+$/i
const RECURSIVE_LETTER = /r/i
// parseCommand trims a closing brace off the last word, so `${HOME}` may arrive as `${HOME`.
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\}?)(?=\/|$)/
const SAFE_REBASE = new Set(['--abort', '--continue', '--quit', '--show-current-patch'])

const COMMIT_FIRST = 'Commit what you want to keep with `gc` first.'
const SAFE_BASE = '`base -- <cmd>` runs a command at HEAD with the working tree untouched, and `git worktree add` gives a clean tree.'

export const RESET_HARD = `Never \`git reset --hard\`: it throws away uncommitted work, and peer sessions edit this tree live. ${COMMIT_FIRST} \`git reset --soft\` or \`--mixed\` moves HEAD and keeps the changes; ${SAFE_BASE}`
export const DISCARD_TREE = `Never discard the whole working tree (\`git checkout -- .\`, \`git checkout -f\`, \`git restore .\`, \`git switch -f\`): it throws away uncommitted work, and peer sessions edit this tree live. ${COMMIT_FIRST} Restore named paths only, and \`git restore --staged\` just unstages. ${SAFE_BASE}`
export const CLEAN = `Never \`git clean -f\`: it deletes untracked files that peer sessions or the user have not committed yet. \`git clean -n\` lists what it would remove; delete named files yourself.`
export const FORCE_PUSH = 'Never force-push with `--force`, `-f`, `--mirror` or a `+refspec`: it overwrites commits on the remote. When the user asked for one, `git push --force-with-lease` refuses to overwrite what you have not seen.'
export const BRANCH_DELETE = 'Never `git branch -D`: it drops commits no other branch holds. `git branch -d` deletes a merged branch only; ask the user before dropping an unmerged one.'
export const REBASE = `Never start a \`git rebase\`: it rewrites history and stops halfway on conflicts in a tree others edit. ${COMMIT_FIRST} \`git cherry-pick\` or \`git merge\` keep history, and \`git worktree add\` gives a clean tree to do it in. \`--continue\` and \`--abort\` stay allowed.`
export const REWRITE_HISTORY = 'Never `git filter-branch` or `git filter-repo`: they rewrite every commit of the repository. Ask the user to run it themselves.'
export const BROAD_RM = 'Never `rm -r` on `/`, `~`, `$HOME`, `.`, `..`, `*` or a top-level directory: it deletes far more than the task. Name the exact directory, such as `dist` or `node_modules`.'
export const PIPE_TO_SHELL = 'Never run what `curl`/`wget` fetches straight in a shell (`| sh`, `bash <(curl ...)`, `eval "$(curl ...)"`): it runs code nobody read. Download it to a file, read it, then run it, or hand the command to the user.'

// Whether a short or long option is among the arguments before a `--`.
function hasOption(args: readonly string[], long: readonly string[], shorts: string): boolean {
  for (const arg of args) {
    if (arg === '--')
      return false

    if (long.includes(arg) || (SHORT_CLUSTER.test(arg) && [...arg.slice(1)].some(letter => shorts.includes(letter))))
      return true
  }

  return false
}

// Whether a path names a place whose removal is far wider than a task: the root, the home, the current or parent directory, a glob of them, or a top-level directory.
export function isBroadPath(arg: string): boolean {
  const home = HOME_PREFIX.exec(arg)
  const isAbsolute = home === null && arg.startsWith('/')
  const parts: string[] = []

  for (const part of (home === null ? arg : arg.slice(home[0].length)).split('/')) {
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..')
      parts.pop()
    else if (part === '..' && !isAbsolute && home === null)
      parts.push(part)
    else if (part !== '' && part !== '.' && part !== '..')
      parts.push(part)
  }

  if (parts.at(-1) === '*' || parts.at(-1) === '.*')
    parts.pop()

  if (home !== null)
    return parts.length === 0

  return isAbsolute ? parts.length <= 1 : parts.every(part => part === '..')
}

function removesBroadly(args: readonly string[]): boolean {
  if (args.includes('--no-preserve-root'))
    return true

  const options = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length)
  const isRecursive = options.some(arg => arg === '--recursive' || (SHORT_CLUSTER.test(arg) && RECURSIVE_LETTER.test(arg)))

  if (!isRecursive)
    return false

  const targets = args.filter((arg, i) => !arg.startsWith('-') || (args.includes('--') && i > args.indexOf('--')))

  return targets.some(isBroadPath)
}

function gitDestructive(name: string, rest: readonly string[]): string | null {
  const operands = rest.filter(arg => !arg.startsWith('-') || arg === '--')

  if (name === 'reset')
    return rest.includes('--hard') ? RESET_HARD : null

  if (name === 'checkout' && (hasOption(rest, ['--force'], 'f') || rest.some(arg => arg !== '--' && !arg.startsWith('-') && isWholeTree(arg) && (rest.includes('--') || operands.length === 1))))
    return DISCARD_TREE

  if (name === 'switch' && hasOption(rest, ['--force', '--discard-changes'], 'f'))
    return DISCARD_TREE

  if (name === 'restore') {
    const isStagedOnly = rest.includes('--staged') && !rest.includes('--worktree')

    return !isStagedOnly && operands.some(arg => arg !== '--' && isWholeTree(arg)) ? DISCARD_TREE : null
  }

  if (name === 'clean')
    return hasOption(rest, ['--force'], 'f') && !hasOption(rest, ['--dry-run'], 'n') ? CLEAN : null

  if (name === 'push') {
    const isForced = hasOption(rest, ['--force', '--mirror'], 'f') || rest.some(arg => arg.startsWith('--force=') || (!arg.startsWith('-') && arg.startsWith('+')))

    return isForced ? FORCE_PUSH : null
  }

  if (name === 'branch')
    return hasOption(rest, [], 'D') || (hasOption(rest, ['--delete'], 'd') && hasOption(rest, ['--force'], 'f')) ? BRANCH_DELETE : null

  if (name === 'rebase')
    return rest.some(arg => SAFE_REBASE.has(arg)) ? null : REBASE

  return name === 'filter-branch' || name === 'filter-repo' ? REWRITE_HISTORY : null
}

// Whether a pipeline feeds a download to a shell, or a shell or `eval` is handed a substitution that downloads.
function runsDownload(command: string): boolean {
  const pieces = splitCommand(command)

  return pieces.some((piece, index) => {
    const { program } = parseCommand(piece.command)

    if (FETCHERS.has(program) && piece.separator === '|') {
      const next = pieces[index + 1]
      const target = next === undefined ? undefined : parseCommand(next.command)

      return target !== undefined && SHELLS.has(target.program) && (!target.args.some(arg => !arg.startsWith('-')) || target.args.includes('-s'))
    }

    return (SHELLS.has(program) || EVALUATORS.has(program)) && (FETCH_SUBSTITUTION.test(piece.command))
  })
}

// Why the command is refused as destructive, or null when no piece throws work away.
export function destructiveViolation(command: string): string | null {
  if (runsDownload(command))
    return PIPE_TO_SHELL

  for (const piece of splitCommand(command)) {
    const { program, args } = parseCommand(piece.command)

    if (program === 'rm' && removesBroadly(args))
      return BROAD_RM

    if (program !== 'git')
      continue

    const { name, rest } = subcommandOf(args)
    const violation = gitDestructive(name, rest)

    if (violation !== null)
      return violation
  }

  return null
}
