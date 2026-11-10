import type { Piece } from '@kaynooo/cli-kit/shell'
import { parseCommand, SHELLS, splitCommand } from '@kaynooo/cli-kit/shell'
import { gitCommandOf, isWholeTree, SHORT_CLUSTER } from './git'

const FETCHERS = new Set(['curl', 'wget', 'fetch'])
// Programs that run the text they are given as commands.
const EVALUATORS = new Set(['eval', 'source', '.'])
const FETCH_SUBSTITUTION = /(?:\$\(|<\(|`)\s*(?:curl|wget|fetch)\b/
const RECURSIVE_LETTER = /r/i
// parseCommand trims a closing brace off the last word, so `${HOME}` may arrive as `${HOME`.
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME(?::?[-?=+][^}]*)?\}?)(?=\/|$)/
// The current directory by name, as `rm -rf $PWD` spells it; the closing of `$(pwd)` may already be trimmed off.
const CURRENT_DIRECTORY = /^(?:\$PWD|\$\{PWD\}?|\$\(pwd\)?|`pwd`?)(?=\/|$)/
// A path under /home/<user> or /root, as the first part of the path inside it.
const ABSOLUTE_HOME = /^(?:home\/[^/]+|root)\/([^/]+)$/
const EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const REMOVER = /(?:^|\/)rm$/
const TRAILING_SLASH = /\/$/
const SAFE_REBASE = new Set(['--abort', '--continue', '--quit', '--show-current-patch', '--skip', '--edit-todo'])
// Programs reading the script they are piped, which a download must not feed.
const INTERPRETERS = new Set(['python', 'node', 'bun', 'perl', 'ruby'])
// An interpreter's version suffix, `python3.12`.
const VERSION_SUFFIX = /[\d.]+$/
// Programs that pass their input on, so a download goes through them to the next stage.
const PASS_THROUGH = new Set(['tee', 'cat', 'pv', 'tr', 'sed'])

const COMMIT_FIRST = 'Commit what you want to keep with `gc` first.'
const SAFE_BASE = '`base -- <cmd>` runs a command at HEAD with the working tree untouched, and `git worktree add` gives a clean tree.'

export const RESET_HARD = `Never \`git reset --hard\`: it throws away uncommitted work, and peer sessions edit this tree live. ${COMMIT_FIRST} \`git reset --soft\` or \`--mixed\` moves HEAD and keeps the changes; ${SAFE_BASE}`
export const DISCARD_TREE = `Never discard the whole working tree (\`git checkout -- .\`, \`git checkout -f\`, \`git restore .\`, \`git rm -r .\`, \`git switch -f\`): it throws away uncommitted work, and peer sessions edit this tree live. ${COMMIT_FIRST} Restore named paths only, and \`git restore --staged\` just unstages. ${SAFE_BASE}`
export const CLEAN = `Never \`git clean -f\`: it deletes untracked files that peer sessions or the user have not committed yet. \`git clean -n\` lists what it would remove; delete named files yourself.`
export const FORCE_PUSH = 'Never force-push with `--force`, `-f`, `--mirror` or a `+refspec`: it overwrites commits on the remote. When the user asked for one, `git push --force-with-lease` refuses to overwrite what you have not seen.'
export const REMOTE_DELETE = 'Never delete a remote branch or tag with `git push --delete` or `git push origin :ref`: it removes work from the remote for everyone. Ask the user to run it themselves.'
export const BRANCH_DELETE = 'Never `git branch -D`: it drops commits no other branch holds. `git branch -d` deletes a merged branch only; ask the user before dropping an unmerged one.'
export const REBASE = `Never start a \`git rebase\`: it rewrites history and stops halfway on conflicts in a tree others edit. ${COMMIT_FIRST} \`git cherry-pick\` or \`git merge\` keep history, and \`git worktree add\` gives a clean tree to do it in. \`--continue\` and \`--abort\` stay allowed.`
export const REWRITE_HISTORY = 'Never `git filter-branch` or `git filter-repo`: they rewrite every commit of the repository. Ask the user to run it themselves.'
export const BROAD_RM = 'Never `rm -r` on `/`, `~`, `$HOME`, `.`, `..`, `*` or a top-level directory: it deletes far more than the task. Name the exact directory, such as `dist` or `node_modules`.'
export const PROTECTED_RM = 'Never `rm -r` on a `.git` directory, on `~/Workspace` itself or on a dot-directory of the home (`~/.ssh`, `$HOME/.claude`, `~/.config`): it deletes a repository\'s whole history, every project, or the credentials and settings of the machine. Remove the named files inside, or ask the user to run it.'
export const FIND_DELETE_HOME = 'Never `find ~ -delete` or `find / -exec rm` (also `$HOME`): it deletes matches across the whole home or disk. Start `find` in the project folder or `.` and name the pattern, such as `find . -name "*.tmp" -delete`.'
export const REFLOG_EXPIRE = 'Never `git reflog expire`, `git gc --prune=now` or `git update-ref -d`: they drop the reflog, unreachable commits or a ref, the only way back from a bad reset or rebase. Let git prune on its own schedule, and ask the user to run one when it is really wanted.'
export const DOCKER_PRUNE_ALL = 'Never `docker system prune -a` (`--all`): it removes every image not used by a running container, volumes of other projects\' stacks included with --volumes. `docker system prune` without -a drops only dangling data; remove named images with `docker rmi`.'
const PINNED_RUN = '`dl <url>` downloads it and prints its path and sha256; read that file, then `dl <url> --exec --sha256 <sha>` runs exactly what was read.'

export const PIPE_TO_SHELL = `Never run what \`curl\`/\`wget\` fetches straight in a shell (\`| sh\`, \`bash <(curl ...)\`, \`eval "$(curl ...)"\`): it runs code nobody read. ${PINNED_RUN} Or hand the command to the user.`
export const UNPINNED_EXEC = `Never \`dl --exec --yes\` a script no \`--sha256\` or \`--sums\` pins: it runs code nobody read. ${PINNED_RUN}`

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
export function isBroadPath(path: string): boolean {
  const arg = path.replace(CURRENT_DIRECTORY, '.')
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

// The paths a recursive removal names, none when it is not recursive.
function recursiveTargets(args: readonly string[]): string[] {
  const options = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length)
  const isRecursive = options.some(arg => arg === '--recursive' || (SHORT_CLUSTER.test(arg) && RECURSIVE_LETTER.test(arg)))

  return isRecursive ? args.filter((arg, i) => !arg.startsWith('-') || (args.includes('--') && i > args.indexOf('--'))) : []
}

// Whether a path is a `.git` directory, `~/Workspace` itself or a dot-directory directly under the home, which a recursive removal must never take.
function isProtectedPath(path: string): boolean {
  const home = HOME_PREFIX.exec(path)
  const parts = (home === null ? path : path.slice(home[0].length)).split('/').filter(part => part !== '' && part !== '.')
  const last = parts.at(-1) ?? ''
  const absolute = path.startsWith('/') ? ABSOLUTE_HOME.exec(parts.join('/')) : null
  const homeChild = parts.length === 1 ? last : undefined
  const child = home === null ? absolute?.[1] : homeChild

  return last === '.git' || (child !== undefined && (child === 'Workspace' || (child.startsWith('.') && child !== '..')))
}

// Whether a `find` starts at the home or the root and deletes what it matches.
function deletesFromHome(args: readonly string[]): boolean {
  const firstOption = args.findIndex(arg => arg.startsWith('-') || arg === '(' || arg === '!')
  const starts = firstOption === -1 ? args : args.slice(0, firstOption)
  const deletes = args.includes('-delete') || args.some((arg, i) => EXEC_FLAGS.has(arg) && REMOVER.test(args[i + 1] ?? ''))

  return deletes && starts.some(start => start === '/' || start.replace(TRAILING_SLASH, '') === HOME_PREFIX.exec(start)?.[0])
}

// Whether the command is `docker system prune` with `-a` or `--all`.
function dockerPrunesAll(args: readonly string[]): boolean {
  const system = args.indexOf('system')

  return system !== -1 && args[system + 1] === 'prune' && hasOption(args.slice(system + 2), ['--all'], 'a')
}

function removesBroadly(args: readonly string[]): boolean {
  return args.includes('--no-preserve-root') || recursiveTargets(args).some(isBroadPath)
}

// Whether a checkout restores the whole tree from its pathspecs: after a `--`, or past the first operand, which is the tree-ish, or alone.
function checksOutTree(rest: readonly string[], operands: readonly string[]): boolean {
  if (rest.includes('--'))
    return operands.some(arg => arg !== '--' && isWholeTree(arg))

  return operands.length === 1 ? isWholeTree(operands[0] ?? '') : operands.slice(1).some(isWholeTree)
}

function gitDestructive(name: string, rest: readonly string[]): string | null {
  const operands = rest.filter(arg => !arg.startsWith('-') || arg === '--')

  if (name === 'reset')
    return rest.includes('--hard') ? RESET_HARD : null

  if (name === 'checkout' && !hasOption(rest, ['--patch'], 'p') && (hasOption(rest, ['--force'], 'f') || checksOutTree(rest, operands)))
    return DISCARD_TREE

  if (name === 'switch' && hasOption(rest, ['--force', '--discard-changes'], 'f'))
    return DISCARD_TREE

  if (name === 'restore') {
    const isStagedOnly = hasOption(rest, ['--staged'], 'S') && !hasOption(rest, ['--worktree'], 'W')

    return !isStagedOnly && !hasOption(rest, ['--patch'], 'p') && operands.some(arg => arg !== '--' && isWholeTree(arg)) ? DISCARD_TREE : null
  }

  if (name === 'rm')
    return !hasOption(rest, ['--cached', '--dry-run'], 'n') && operands.some(arg => arg !== '--' && isWholeTree(arg)) ? DISCARD_TREE : null

  if (name === 'clean')
    return hasOption(rest, ['--force'], 'f') && !hasOption(rest, ['--dry-run'], 'n') ? CLEAN : null

  if (name === 'push') {
    const isForced = hasOption(rest, ['--force', '--mirror'], 'f') || rest.some(arg => arg.startsWith('--force=') || (!arg.startsWith('-') && arg.startsWith('+')))

    if (isForced)
      return FORCE_PUSH

    return hasOption(rest, ['--delete'], 'd') || rest.some(arg => arg.startsWith(':') && arg.length > 1) ? REMOTE_DELETE : null
  }

  if (name === 'branch')
    return hasOption(rest, [], 'D') || (hasOption(rest, ['--delete'], 'd') && hasOption(rest, ['--force'], 'f')) ? BRANCH_DELETE : null

  if (name === 'reflog')
    return rest[0] === 'expire' ? REFLOG_EXPIRE : null

  if (name === 'gc')
    return rest.some(arg => arg === '--prune=now' || arg === '--prune=all') ? REFLOG_EXPIRE : null

  if (name === 'update-ref')
    return hasOption(rest, ['--delete'], 'd') ? REFLOG_EXPIRE : null

  if (name === 'rebase')
    return rest.some(arg => SAFE_REBASE.has(arg)) ? null : REBASE

  return name === 'filter-branch' || name === 'filter-repo' ? REWRITE_HISTORY : null
}

// Whether the stages after a download, through the ones passing it on, end in a shell or an interpreter reading it as its script.
function feedsExecutor(stages: readonly Piece[]): boolean {
  for (const stage of stages) {
    const { program, args } = parseCommand(stage.command)
    const hasScript = args.some(arg => !arg.startsWith('-'))

    if (SHELLS.has(program))
      return !hasOption(args, [], 'n') && (!hasScript || args.includes('-s'))

    if (INTERPRETERS.has(program.replace(VERSION_SUFFIX, '')))
      return !hasScript

    if (!PASS_THROUGH.has(program) || stage.separator !== '|')
      return false
  }

  return false
}

// Whether a pipeline feeds a download to a shell, or a shell or `eval` is handed a substitution that downloads.
function runsDownload(command: string): boolean {
  const pieces = splitCommand(command)

  return pieces.some((piece, index) => {
    const { program } = parseCommand(piece.command)

    if (FETCHERS.has(program) && piece.separator === '|')
      return feedsExecutor(pieces.slice(index + 1))

    return (SHELLS.has(program) || EVALUATORS.has(program)) && (FETCH_SUBSTITUTION.test(piece.command))
  })
}

// Whether `dl` is told to run its script on --yes alone, with neither a sha256 nor a checksums file pinning it.
function runsUnpinned(args: readonly string[]): boolean {
  const own = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  const given = (name: string) => own.some(arg => arg === name || arg.startsWith(`${name}=`))

  return given('--exec') && given('--yes') && !given('--sha256') && !given('--sums')
}

// Why the command is refused as destructive, or null when no piece throws work away.
export function destructiveViolation(command: string): string | null {
  if (runsDownload(command))
    return PIPE_TO_SHELL

  for (const piece of splitCommand(command)) {
    const { program, args } = parseCommand(piece.command)

    if (program === 'dl' && runsUnpinned(args))
      return UNPINNED_EXEC

    if (program === 'rm' && removesBroadly(args))
      return BROAD_RM

    if (program === 'rm' && recursiveTargets(args).some(isProtectedPath))
      return PROTECTED_RM

    if (program === 'find' && deletesFromHome(args))
      return FIND_DELETE_HOME

    if (program === 'docker' && dockerPrunesAll(args))
      return DOCKER_PRUNE_ALL

    const git = gitCommandOf(program, args)

    if (git === undefined)
      continue

    const violation = gitDestructive(git.name, git.rest)

    if (violation !== null)
      return violation
  }

  return null
}
