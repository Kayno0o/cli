import { parseCommand, splitCommand } from '@kaynooo/cli-kit/shell'
import { COMMIT_VALUE_LONGS, COMMIT_VALUE_SHORTS, SHORT_CLUSTER, subcommandOf } from './git'

// What a commit's message is made of: the `-m` texts, a `-F` file (`-` reading the heredoc fed to it), or nothing to check when git reuses a message or opens an editor.
export interface CommitSource { parts: string[], file: string | null, stdin: string | null, isReused: boolean, hasTrailerFlag: boolean }

const REUSES = new Set(['c', 'C', '--reuse-message', '--reedit-message', '--fixup', '--squash'])
const TRAILER_FLAGS = new Set(['--signoff', '--trailer'])
const LONG_VALUE = /=(.*)/s
const CAT_OPENER = /^\$\(cat <<-?[ \t]*(['"]?)([\w-]+)\1/
const GLOB = /[*?[]/
// `-m<text>`, `-qm`, `--message=<text>`, `-q`: the only commit options gc reproduces
const PLAIN_COMMIT_OPTION = /^(?:-q?m.*|-q|--quiet|--message=.*)$/s

export const HEREDOC_OPENER = /<<-?[ \t]*(['"]?)([\w-]+)\1/
const TICKET_LINE = /^(?:[\w.-]+\/[\w.-]+)?#\d+ - /
// parseCommand trims the closing parenthesis off the last word, so it may be gone.
const CAT_CLOSER = /^\s*(?:\)\s*)?$/
// Text the shell would still expand, which leaves the message unknown.
const EXPANDS = /\$[({\w]|`/

// The body of the first heredoc the opener finds, up to its delimiter line (which may carry the `)` closing a `$(cat ...)`), and the text after that line; the rest of the opener's line is the command's.
export function heredocBody(text: string, opener: RegExp): { body: string, rest: string } | undefined {
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

    // the splitter hands a heredoc body to the piece after a `&&`, `;` or `|` that follows its opener, so a piece with an opener reads on from its start
    if (name === 'commit')
      sources.push(sourceOf(rest, HEREDOC_OPENER.test(piece.text) ? command.slice(piece.start) : piece.text))
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

function quoted(text: string): string {
  return `'${text.replaceAll('\'', '\'\\\'\'')}'`
}

// The paths of the `git add` commands in the command, null when one stages without naming paths or there is none.
function addedPaths(command: string): string[] | null {
  const paths: string[] = []

  for (const piece of splitCommand(command)) {
    const { program, args } = parseCommand(piece.command)
    const { name, rest } = program === 'git' ? subcommandOf(args) : { name: '', rest: [] }

    if (name !== 'add')
      continue

    const operands = rest.filter(arg => arg !== '--')

    // gc takes its paths literally, so a glob git would expand stays git's
    if (operands.length === 0 || operands.some(arg => arg.startsWith('-') || GLOB.test(arg)))
      return null

    paths.push(...operands)
  }

  return paths.length === 0 ? null : paths
}

// Whether every git call in the command is a bare `git add` or a `git commit` given only its message (`-m`, `-q`), which gc reproduces; `--amend`, `-a`, `--no-verify` or `git -C <dir>` it would drop.
function isPlainChain(command: string): boolean {
  for (const piece of splitCommand(command)) {
    const { program, args } = parseCommand(piece.command)

    if (program !== 'git')
      continue

    const { name, rest } = subcommandOf(args)

    if (args[0] !== name)
      return false

    if (name !== 'commit')
      continue

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] ?? ''

      if (arg === '-m' || arg === '-qm' || arg === '--message')
        i++
      else if (!PLAIN_COMMIT_OPTION.test(arg))
        return false
    }
  }

  return true
}

// The `gc` line doing what a `git add <paths>` then `git commit -m ...` chain does, null when the chain is no such pair, carries an option gc lacks or its message is not known.
export function gcLine(command: string): string | null {
  if (!isPlainChain(command))
    return null

  const paths = addedPaths(command)
  const [source, ...others] = commitSources(command)

  if (paths === null || source === undefined || others.length > 0 || source.file !== null || source.isReused || source.hasTrailerFlag)
    return null

  const lines = (inlineMessage(source.parts) ?? '').split('\n').map(line => line.trim()).filter(line => line !== '')
  const [title, ...rest] = lines

  if (title === undefined)
    return null

  const options = rest.map(line => TICKET_LINE.test(line) ? `--ticket ${quoted(line)}` : `-m ${quoted(line)}`)

  return ['gc', quoted(title), ...options, '--', ...paths.map(quoted)].join(' ')
}
