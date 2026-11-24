import type { Note } from './match'
import type { Operator, Redirect, Word } from './shell'
import { basename } from 'node:path'
import { loadHelp } from './help'
import { loadPage } from './man'
import { explain } from './match'
import { parseLine, unwrapCommand } from './shell'

export interface Gloss {
  name: string
  // The page the options came from (`git-commit` for `git commit`), or undefined when there is none.
  page: string | undefined
  summary: string | undefined
  source: 'man' | 'help' | undefined
  wrappers?: string[]
  assigns: string[]
  notes: Note[]
  redirects: { token: string, text: string }[]
  substitutions: Line[]
  next: Operator | undefined
}

export interface Line {
  line: string
  commands: Gloss[]
}

const MAX_DEPTH = 3
const SINGLE_DIGIT = /^\d$/
const SAFE_NAME = /^[\w.+-]+$/

// Git global flags that precede a subcommand (`git -C /repo -c k=v --no-pager commit -am fix`).
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '--list-cmds'])
const GIT_BOOL_FLAGS = new Set(['-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch', '--no-advice'])

const REDIRECTS: Record<string, string> = {
  '>': 'writes the output to',
  '>>': 'appends the output to',
  '<': 'reads the input from',
  '<<': 'reads the input from the here-document ending at',
  '<<-': 'reads the input from the here-document ending at',
  '<<<': 'reads the input from the string',
  '&>': 'writes the output and the errors to',
  '&>>': 'appends the output and the errors to',
  '>&': 'sends the output to',
  '<&': 'reads the input from',
  '>|': 'writes the output, even over an existing file, to',
}

const FDS: Record<string, string> = { 0: 'the input', 1: 'the output', 2: 'the errors' }

export function describeRedirect(redirect: Redirect): { token: string, text: string } {
  const base = REDIRECTS[redirect.op] ?? redirect.op
  const raw = redirect.target?.text ?? ''
  const joined = redirect.op.endsWith('&')
  const target = joined && SINGLE_DIGIT.test(raw) ? (FDS[raw] ?? raw) : raw
  const channel = redirect.fd === undefined ? undefined : (FDS[redirect.fd] ?? `descriptor ${redirect.fd}`)
  const what = channel === undefined ? base : base.replace('the output', channel).replace('the input', channel)

  return { token: `${redirect.fd ?? ''}${redirect.op}${joined ? '' : ' '}${raw}`.trimEnd(), text: `${what} ${target}`.trimEnd() }
}

function describeSubcommand(name: string, word: Word | undefined, env: Record<string, string | undefined>): { page: ReturnType<typeof loadPage>, used: string } | undefined {
  if (word === undefined || word.text.startsWith('-') || !SAFE_NAME.test(word.text))
    return undefined

  const page = loadPage(`${name}-${word.text}`, env)

  return page === undefined ? undefined : { page, used: `${name}-${word.text}` }
}

// Scans past git global flags (`-C <dir>`, `-c <k=v>`, `--no-pager`, etc.) to locate the real subcommand index in `words`.
function gitSubcommandIndex(words: Word[]): number {
  let i = 1

  while (i < words.length) {
    const token = words[i]!.text

    if (!token.startsWith('-') || token === '--')
      return i

    if (GIT_VALUE_FLAGS.has(token)) {
      i += 2

      continue
    }

    const eq = token.indexOf('=')

    if (eq !== -1 && GIT_VALUE_FLAGS.has(token.slice(0, eq))) {
      i++

      continue
    }

    if (GIT_BOOL_FLAGS.has(token) || (token.startsWith('-C') && token.length > 2) || (token.startsWith('-c') && token.length > 2)) {
      i++

      continue
    }

    return -1
  }

  return -1
}

function sourceOf(page: unknown, fromHelp: boolean): Gloss['source'] {
  if (page === undefined)
    return undefined

  return fromHelp ? 'help' : 'man'
}

export interface AnalyzeSettings {
  env?: Record<string, string | undefined>
  // Reads the options of a command with no man page from its --help output, which runs the command.
  runHelp?: boolean
}

export function analyze(line: string, settings: AnalyzeSettings = {}, depth = 0): Line {
  const { env = process.env, runHelp = false } = settings
  const commands: Gloss[] = []

  for (const { command, next } of parseLine(line)) {
    const unwrapped = unwrapCommand(command.words)
    const activeWords = unwrapped.words
    const [head] = activeWords
    const name = head?.text ?? ''
    // A command given by its absolute path has its page under its name; a relative one such as ./ls is a local script, whatever system command it shares a name with.
    const paged = name.startsWith('/') ? basename(name) : name
    const subIndex = paged === 'git' ? gitSubcommandIndex(activeWords) : 1
    const subWord = subIndex > 0 ? activeWords[subIndex] : undefined
    const globalWords = subIndex > 1 ? activeWords.slice(1, subIndex) : []
    const sub = head === undefined ? undefined : describeSubcommand(paged, subWord, env)
    const rootManual = head === undefined ? undefined : loadPage(paged, env)
    const manual = sub?.page ?? rootManual
    const page = manual ?? (runHelp && head !== undefined ? loadHelp(name, subWord?.text, env) : undefined)
    const fromHelp = manual === undefined && page !== undefined
    const usedSub = sub !== undefined || (fromHelp && page?.name.includes(' ') === true)
    const restWords = usedSub ? activeWords.slice(subIndex + 1) : activeWords.slice(1)
    const notes: Note[] = []

    if (usedSub && globalWords.length > 0)
      notes.push(...explain(globalWords, rootManual?.options ?? []))

    notes.push(...explain(restWords, page?.options ?? []))

    commands.push({
      name: usedSub && subWord !== undefined ? `${name} ${subWord.text}` : name,
      page: sub?.used ?? (page === undefined ? undefined : page.name),
      source: sourceOf(page, fromHelp),
      summary: page?.summary,
      ...unwrapped.wrappers.length === 0 ? {} : { wrappers: unwrapped.wrappers },
      assigns: [...command.assigns.map(word => word.text), ...unwrapped.assigns],
      notes,
      redirects: command.redirects.map(describeRedirect),
      substitutions: depth >= MAX_DEPTH ? [] : command.substitutions.map(inner => analyze(inner, settings, depth + 1)),
      next,
    })
  }

  return { line, commands }
}
