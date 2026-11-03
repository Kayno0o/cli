import type { Piece } from '@kaynooo/cli-kit/shell'
import { parseCommand, tokenize } from '@kaynooo/cli-kit/shell'
import { namesEnv } from './guard-names'
import { searchesEnvNames } from './guard-search'

// Programs an `xargs` can run on a listing of names without printing a line of the files.
const XARGS_SAFE = new Set(['ls', 'stat', 'wc', 'test', '[', 'touch', 'echo', 'printf', 'basename', 'dirname', 'ev', 'redact', ''])
// GNU parallel's options taking their value as the next word, before the command it runs.
const PARALLEL_VALUE_OPTIONS = new Set(['-j', '--jobs', '-P', '--max-procs', '-S', '--sshlogin', '-C', '--colsep', '-n', '--max-args', '-N', '-d', '--delimiter', '-E', '-I', '--timeout', '--delay', '--joblog', '--results', '--tmpdir', '-a', '--arg-file', '--halt', '--retries', '--tag-string'])
const IDENTIFIER = /^[A-Z_]\w*$/i
// `read`'s options taking a value, which is not a variable it fills.
const READ_VALUE_OPTIONS = new Set(['-a', '-d', '-i', '-n', '-N', '-p', '-t', '-u'])

// Whether a piece further up the pipeline that `index` starts lists env files by name.
function listsEnvUpstream(pieces: readonly Piece[], index: number, variables: ReadonlyMap<string, string[]>): boolean {
  for (let at = index - 1; at >= 0 && pieces[at]?.separator.startsWith('|'); at--) {
    if (namesEnv(pieces[at] as Piece, variables) || searchesEnvNames(pieces[at] as Piece))
      return true
  }

  return false
}

// The program GNU parallel runs on each name it is fed, `cat` in `parallel -j4 cat {}`.
function parallelRunner(args: readonly string[]): string {
  const at = args.findIndex((arg, i) => !arg.startsWith('-') && !PARALLEL_VALUE_OPTIONS.has(args[i - 1] ?? ''))

  return at === -1 ? '' : (args[at] ?? '').split('/').at(-1) ?? ''
}

// Whether the piece is an `xargs` or `parallel` running a command that may print the files it is given the names of, on a listing naming an env file further up its pipeline (harmless alone, but each name gets opened).
export function runnerReadsListedEnv(pieces: readonly Piece[], index: number, variables: ReadonlyMap<string, string[]>): boolean {
  const command = pieces[index]?.command ?? ''
  const { program, args, isWrapped } = parseCommand(command)
  // parseCommand sees through `xargs` to the command it runs, not through `parallel`
  const isXargs = isWrapped && tokenize(command).includes('xargs')

  if (program !== 'parallel' && !isXargs)
    return false

  return !XARGS_SAFE.has(isXargs ? program : parallelRunner(args)) && listsEnvUpstream(pieces, index, variables)
}

// The variables a `read` fills, REPLY when it names none.
function readVariables(args: readonly string[]): string[] {
  const names = args.filter((arg, i) => !arg.startsWith('-') && !READ_VALUE_OPTIONS.has(args[i - 1] ?? '') && IDENTIFIER.test(arg))

  return names.length === 0 ? ['REPLY'] : names
}

// Whether the piece sits in the body of a `while read` loop fed a listing naming an env file, and hands one of the names read to a command that may print the file.
export function loopReadsListedEnv(pieces: readonly Piece[], index: number, variables: ReadonlyMap<string, string[]>): boolean {
  const { program } = parseCommand(pieces[index]?.command ?? '')

  if (XARGS_SAFE.has(program) || program === 'done')
    return false

  for (let at = index - 1; at >= 0; at--) {
    const piece = pieces[at] as Piece
    const head = parseCommand(piece.command)

    if (head.program === 'done')
      return false

    const opener = tokenize(piece.command)[0]

    if (head.program !== 'read' || (opener !== 'while' && opener !== 'until'))
      continue

    const used = readVariables(head.args).some(name => new RegExp(`\\$\\{?${name}\\b`).test(pieces[index]?.command ?? ''))

    return used && listsEnvUpstream(pieces, at, variables)
  }

  return false
}
