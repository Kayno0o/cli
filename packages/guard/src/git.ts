import { parseCommand, splitCommand } from '@kaynooo/cli-kit'

// git's own options that take the next word as their value, before the subcommand.
const GLOBAL_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
const READ_ONLY_STASH = new Set(['list', 'show'])
const WHOLE_TREE = new Set(['-A', '--all', '-u', '--update', '--no-ignore-removal', '.', './', ':/', '*'])

// commit's short options taking a value, which ends a cluster such as `-am`.
export const COMMIT_VALUE_SHORTS = new Set(['m', 'F', 'c', 'C', 't'])
export const COMMIT_VALUE_LONGS = new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--fixup', '--squash', '--cleanup', '--trailer', '--pathspec-from-file'])
export const SHORT_CLUSTER = /^-[A-Z]+$/i
const STAGES_ALL = /[Au]/
const ALL_TAGS = new Set(['--tags', '--follow-tags'])

const STAGE_BY_PATH = 'Stage by path (`git add <path>...`, then `git status`): the tree carries unrelated work and peer sessions edit it live.'

export const STASH = 'Never `git stash`: a pop with nothing saved applies someone else\'s old stash. To see how a test behaves without your change, run it at HEAD with `base -- <cmd>` (a temporary worktree, the working tree untouched), `--keep <path>` to carry the new test over, `--ref <rev>` for another commit.'
export const ADD_ALL = `\`git add\` over the whole tree is refused. ${STAGE_BY_PATH}`
export const COMMIT_ALL = `\`git commit -a\` stages the whole tree and is refused. ${STAGE_BY_PATH}`
export const PUSH = '`git push` runs only when the user asked for a push in their latest prompt: say the commit is ready and let them ask.'
export const TAGS_APART = 'A tag goes out with its branch in one `git push --atomic origin <branch> <tag>`, never a separate `git push --tags`.'

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

    if (!SHORT_CLUSTER.test(arg))
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
    const { program, args } = parseCommand(piece.command)

    if (program !== 'git')
      continue

    const { name, rest } = subcommandOf(args)

    if (name === 'stash' && !READ_ONLY_STASH.has(rest[0] ?? ''))
      return STASH

    if (name === 'add' && rest.some(arg => WHOLE_TREE.has(arg) || (SHORT_CLUSTER.test(arg) && STAGES_ALL.test(arg))))
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
