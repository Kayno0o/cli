import { USE_GC } from '@kaynooo/cli-git/message'
import { parseCommand, splitCommand } from '@kaynooo/cli-kit/shell'

// git's own options that take the next word as their value, before the subcommand.
const GLOBAL_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
const READ_ONLY_STASH = new Set(['list', 'show'])
const WHOLE_TREE = new Set(['-A', '--all', '-u', '--update', '--no-ignore-removal', '.', './', ':/', '*'])

// commit's short options taking a value, which ends a cluster such as `-am`.
export const COMMIT_VALUE_SHORTS = new Set(['m', 'F', 'c', 'C', 't'])
export const COMMIT_VALUE_LONGS = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--fixup', '--squash', '--cleanup', '--trailer', '--pathspec-from-file'])
export const SHORT_CLUSTER = /^-[A-Z]+$/i
// A short option cluster that may end in an attached value, `-m"fix: x"` reaching the parser as `-mfix: x`.
export const SHORT_OPTIONS = /^-[A-Z]/i
const STAGES_ALL = /[Au]/
const ALL_TAGS = new Set(['--tags', '--follow-tags'])
// A pathspec's leading magic naming the repository root.
const TOP_MAGIC = /^:(?:\/|\([^)]*\))/
// Config keys that run a program or define a command (an alias runs anything, `!git push` included), which `-c` or `git config` must not set.
const RISKY_CONFIG = /^(?:alias\.|core\.(?:sshcommand|hookspath|pager|editor|fsmonitor|askpass|gitproxy)|credential\.|diff\.external|sequence\.editor|pager\.|filter\.|gpg\..*program)/i
const RISKY_ENV = /^GIT_(?:CONFIG_(?:COUNT|PARAMETERS)|EXTERNAL_DIFF|ASKPASS|PROXY_COMMAND|PAGER)=/
const READS_CONFIG = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--unset', '--unset-all', '--show-origin', '--show-scope'])

const STAGE_BY_PATH = `Stage by path: the tree carries unrelated work and peer sessions edit it live. ${USE_GC}`

export const STASH = 'Never `git stash`: a pop with nothing saved applies someone else\'s old stash. To prove a test fails without your change, `base proof --keep <test> -- <cmd>` runs it at HEAD in a temporary worktree and again here; `base -- <cmd>` runs any command at HEAD (`--ref <rev>` another commit), the working tree untouched. To set edits aside before a cherry-pick, a rebase or a checkout, commit them with `gc` first, or do the other work in `git worktree add`.'
export const ADD_ALL = `\`git add\` over the whole tree is refused. ${STAGE_BY_PATH}`
export const COMMIT_ALL = `\`git commit -a\` stages the whole tree and is refused. ${STAGE_BY_PATH}`
export const PUSH = '`git push` and `gp` run only when the user asked for a push in their latest prompt: say the commit is ready and let them ask.'
export const CONFIG_OVERRIDE = 'Never set git config that runs a program or defines a command (`-c alias.*`, `--config-env`, `core.sshCommand`, `core.hooksPath`, `core.pager`, credential helpers, `git config alias.*`): it sidesteps every rule here. Run the git command itself.'
export const TAGS_APART = 'A tag goes out with its branch in one `git push --atomic origin <branch> <tag>`, never a separate `git push --tags`.'

/** The git subcommand a command runs: git's own, or `push` for `gp` (@kaynooo/cli-git), what follows its `--` being the push's flags. */
export function gitCommandOf(program: string, args: readonly string[]): { name: string, rest: string[] } | undefined {
  if (program === 'gp')
    return { name: 'push', rest: args.includes('--') ? args.slice(args.indexOf('--') + 1) : [] }

  return program === 'git' ? subcommandOf(args) : undefined
}

export function subcommandOf(args: readonly string[]): { name: string, rest: string[] } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (GLOBAL_VALUE_OPTIONS.has(arg))
      i++
    else if (!arg.startsWith('-'))
      return { name: arg, rest: args.slice(i + 1) }
  }

  return { name: '', rest: [] }
}

// Whether the options before the subcommand override config in a way that runs a program or defines a command.
function overridesConfig(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (arg === '--config-env' || arg.startsWith('--config-env='))
      return true

    if (arg === '-c' && RISKY_CONFIG.test(args[i + 1] ?? ''))
      return true

    if (GLOBAL_VALUE_OPTIONS.has(arg))
      i++
    else if (!arg.startsWith('-'))
      return false
  }

  return false
}

// A pathspec naming the whole tree, however it is spelled: `.`, `src/..`, `:/`, `:/.`, `*`.
export function isWholeTree(arg: string): boolean {
  if (WHOLE_TREE.has(arg))
    return true

  if (arg.startsWith('-'))
    return SHORT_CLUSTER.test(arg) && STAGES_ALL.test(arg)

  const parts: string[] = []

  for (const part of arg.replace(TOP_MAGIC, '').split('/')) {
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..')
      parts.pop()
    else if (part !== '' && part !== '.')
      parts.push(part)
  }

  const path = parts.join('/')

  return path === '' || path === '..' || WHOLE_TREE.has(path)
}

function commitsAll(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (arg === '--')
      return false

    if (arg === '--all')
      return true

    if (COMMIT_VALUE_LONGS.has(arg)) {
      i++

      continue
    }

    if (!SHORT_OPTIONS.test(arg))
      continue

    for (const [index, flag] of [...arg.slice(1)].entries()) {
      if (flag === 'a')
        return true

      if (!COMMIT_VALUE_SHORTS.has(flag))
        continue

      // a value-taking option ends the cluster, the value being what follows it or the next word
      if (index === arg.length - 2)
        i++

      break
    }
  }

  return false
}

// Why the command is refused, or null when no piece breaks a git rule; a push needs the user to have asked for one.
export function gitViolation(command: string, isPushAsked = false): string | null {
  for (const piece of splitCommand(command)) {
    const { program, args, assignments } = parseCommand(piece.command)

    if (assignments.some(assignment => RISKY_ENV.test(assignment)))
      return CONFIG_OVERRIDE

    const git = gitCommandOf(program, args)

    if (git === undefined)
      continue

    if (program === 'git' && overridesConfig(args))
      return CONFIG_OVERRIDE

    const { name, rest } = git

    if (name === 'config' && rest.length > 1 && rest.some(arg => RISKY_CONFIG.test(arg)) && !rest.some(arg => READS_CONFIG.has(arg)))
      return CONFIG_OVERRIDE

    if (name === 'stash' && !READ_ONLY_STASH.has(rest[0] ?? ''))
      return STASH

    if (name === 'add' && rest.some(isWholeTree))
      return ADD_ALL

    if (name === 'commit' && commitsAll(rest))
      return COMMIT_ALL

    if (name === 'push' && !isPushAsked)
      return PUSH

    if (name === 'push' && rest.some(arg => ALL_TAGS.has(arg)) && !rest.includes('--atomic'))
      return TAGS_APART
  }

  return null
}
