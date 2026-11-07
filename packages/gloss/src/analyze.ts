import type { Note } from './match'
import type { Operator, Redirect, Word } from './shell'
import { loadHelp } from './help'
import { loadPage } from './man'
import { explain } from './match'
import { parseLine } from './shell'

export interface Gloss {
  name: string
  // The page the options came from (`git-commit` for `git commit`), or undefined when there is none.
  page: string | undefined
  summary: string | undefined
  source: 'man' | 'help' | undefined
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
    const [head, second] = command.words
    const name = head?.text ?? ''
    const sub = head === undefined ? undefined : describeSubcommand(name, second, env)
    const manual = sub?.page ?? (head === undefined ? undefined : loadPage(name, env))
    const page = manual ?? (runHelp && head !== undefined ? loadHelp(name, second?.text, env) : undefined)
    const fromHelp = manual === undefined && page !== undefined
    const words = command.words.slice(sub === undefined && !(fromHelp && page?.name.includes(' ')) ? 1 : 2)
    const notes: Note[] = []

    notes.push(...explain(words, page?.options ?? []))

    commands.push({
      name: sub === undefined && !(fromHelp && page?.name.includes(' ')) ? name : `${name} ${second?.text}`,
      page: sub?.used ?? (page === undefined ? undefined : page.name),
      source: sourceOf(page, fromHelp),
      summary: page?.summary,
      assigns: command.assigns.map(word => word.text),
      notes,
      redirects: command.redirects.map(describeRedirect),
      substitutions: depth >= MAX_DEPTH ? [] : command.substitutions.map(inner => analyze(inner, settings, depth + 1)),
      next,
    })
  }

  return { line, commands }
}
