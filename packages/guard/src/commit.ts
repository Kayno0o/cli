import { parseCommand, splitCommand } from '@kaynooo/cli-kit/shell'
import { COMMIT_VALUE_LONGS, COMMIT_VALUE_SHORTS, SHORT_CLUSTER, subcommandOf } from './git'

// What a commit's message is made of: the `-m` texts, a `-F` file (`-` reading the heredoc fed to it), or nothing to check when git reuses a message or opens an editor.
export interface CommitSource { parts: string[], file: string | null, stdin: string | null, isReused: boolean, hasTrailerFlag: boolean }

const REUSES = new Set(['c', 'C', '--reuse-message', '--reedit-message', '--fixup', '--squash'])
const TRAILER_FLAGS = new Set(['--signoff', '--trailer'])
const LONG_VALUE = /=(.*)/s
const CAT_OPENER = /^\$\(cat <<-?[ \t]*(['"]?)([\w-]+)\1/
const HEREDOC_OPENER = /<<-?[ \t]*(['"]?)([\w-]+)\1/
// parseCommand trims the closing parenthesis off the last word, so it may be gone.
const CAT_CLOSER = /^\s*(?:\)\s*)?$/
// Text the shell would still expand, which leaves the message unknown.
const EXPANDS = /\$[({\w]|`/

// The body of the first heredoc the opener finds, up to its delimiter line (which may carry the `)` closing a `$(cat ...)`), and the text after that line; the rest of the opener's line is the command's.
function heredocBody(text: string, opener: RegExp): { body: string, rest: string } | undefined {
  const found = opener.exec(text)

  const newline = found === null ? -1 : text.indexOf('\n', found.index + found[0].length)

  if (found === null || newline === -1)
    return undefined

  const lines = text.slice(newline + 1).split('\n')
  const end = lines.findIndex(line => line.trim() === found[2] || line.trim() === `${found[2]})`)

  return end === -1 ? undefined : { body: lines.slice(0, end).join('\n'), rest: lines.slice(end + 1).join('\n') }
}

function sourceOf(args: readonly string[], text: string): CommitSource {
  const source: CommitSource = { parts: [], file: null, stdin: null, isReused: false, hasTrailerFlag: false }
  const take = (option: string, value: string) => {
    if (option === 'm' || option === '--message')
      source.parts.push(value)

    if (option === 'F' || option === '--file')
      source.file = value

    if (REUSES.has(option))
      source.isReused = true

    if (option === '--trailer')
      source.hasTrailerFlag = true
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''

    if (arg === '--')
      break

    if (arg.startsWith('--')) {
      const [option = '', value] = arg.split(LONG_VALUE)

      if (TRAILER_FLAGS.has(option))
        source.hasTrailerFlag = true

      if (REUSES.has(option))
        source.isReused = true

      if (value !== undefined)
        take(option, value)
      else if (COMMIT_VALUE_LONGS.has(option))
        take(option, args[++i] ?? '')

      continue
    }

    if (!SHORT_CLUSTER.test(arg))
      continue

    for (const [index, flag] of [...arg.slice(1)].entries()) {
      if (flag === 's')
        source.hasTrailerFlag = true

      if (!COMMIT_VALUE_SHORTS.has(flag))
        continue

      // a value-taking option ends the cluster, the value being what follows it or the next word
      take(flag, index === arg.length - 2 ? (args[++i] ?? '') : arg.slice(index + 2))

      break
    }
  }

  if (source.file === '-')
    source.stdin = heredocBody(text, HEREDOC_OPENER)?.body ?? null

  return source
}

// Each `git commit` in the command, with where its message comes from.
export function commitSources(command: string): CommitSource[] {
  const sources: CommitSource[] = []

  for (const piece of splitCommand(command)) {
    const { program, args } = parseCommand(piece.command)
    const { name, rest } = program === 'git' ? subcommandOf(args) : { name: '', rest: [] }

    if (name === 'commit')
      sources.push(sourceOf(rest, piece.text))
  }

  return sources
}

// The `-m` texts as git joins them, null when the shell would still expand one.
export function inlineMessage(parts: readonly string[]): string | null {
  const texts: string[] = []

  for (const part of parts) {
    const found = heredocBody(part, CAT_OPENER)
    const body = found !== undefined && CAT_CLOSER.test(found.rest) ? found.body : undefined

    if (body === undefined && EXPANDS.test(part))
      return null

    texts.push(body ?? part)
  }

  return texts.join('\n\n')
}
