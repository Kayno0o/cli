import type { Candidate, Options } from './args'
import { Completing, completion } from './args'
import { COMPLETION_SHELLS, completionScript } from './completions'

// A command's one-line summary, or a function reading it (a lazily loaded module) that only a listing of the command awaits, never a run.
export type Summary = string | (() => Promise<string>)

export type Commands = Record<string, Command>

// Commands known only once something is read, called with the words typed so far from the CLI's name on, and only when a word is not a command the level already has, or for a help or `__complete`.
export type LazyCommands = (words: string[]) => Promise<Commands>

export type Command = {
  summary: Summary
  // The heading the command is listed under in the help, after those with none.
  group?: string
  // Runs as usual but is left out of the help, the typo hints and `__complete`, for a command only a script or a shell binding calls.
  hidden?: boolean
} & (
  | { run: (args: string[]) => Promise<number> }
  // A group of subcommands dispatched the same way, with its own help; `commands` may be a function for a group made of lazy commands alone.
  | { commands: Commands | LazyCommands, extraCommands?: LazyCommands, aliases?: Record<string, string>, defaultCommand?: string, runBare?: boolean, examples?: import('./args').Example[] }
)

// What a level lists and dispatches: the commands it has, and the functions giving more once called.
export interface Scope {
  commands: Commands
  lazy: LazyCommands[]
  aliases: Record<string, string> | undefined
}

// The hidden first argument a shell completion calls a bin with: `<bin> __complete <words typed after it>... <word being typed>`.
export const COMPLETE = '__complete'
// Printed instead of candidates where a path fits, for the shell to complete files itself.
export const FILES = '__files__'
// The flag a bin prints its own completion script for: `<bin> --completions fish`.
export const COMPLETIONS = '--completions'

// The commands that are not hidden.
export function shown(commands: Commands): Commands {
  return Object.fromEntries(Object.entries(commands).filter(([, { hidden }]) => hidden !== true))
}

export async function resolveSummary(summary: Summary): Promise<string> {
  return typeof summary === 'string' ? summary : summary()
}

// The command a word names, through an alias; own keys only, so `toString` or `constructor` names nothing.
export function lookup({ commands, aliases }: Pick<Scope, 'commands' | 'aliases'>, word: string): Commands[string] | undefined {
  const name = aliases !== undefined && Object.hasOwn(aliases, word) ? (aliases[word] ?? word) : word

  return Object.hasOwn(commands, name) ? commands[name] : undefined
}

export function scopeOf(commands: Commands | LazyCommands, extra: LazyCommands | undefined, aliases: Record<string, string> | undefined): Scope {
  return { commands: typeof commands === 'function' ? {} : commands, lazy: [...typeof commands === 'function' ? [commands] : [], ...extra === undefined ? [] : [extra]], aliases }
}

// The scope with its lazy commands called with the words typed so far and merged in, the ones it already has winning a shared name.
export async function expand<T extends Scope>(scope: T, words: string[]): Promise<T> {
  if (scope.lazy.length === 0)
    return scope

  const commands = { ...scope.commands }

  for (const added of await Promise.all(scope.lazy.map(async lazy => lazy(words)))) {
    for (const [name, command] of Object.entries(added))
      commands[name] ??= command
  }

  return { ...scope, commands, lazy: [] }
}

// What a command declares to its completion, read by running it until its parse call throws it: every command parses its arguments before anything else.
async function completingOf(run: (args: string[]) => Promise<number>): Promise<Completing> {
  completion.active = true

  try {
    await run([])
  }
  catch (error) {
    if (error instanceof Completing)
      return error
  }
  finally {
    completion.active = false
  }

  return new Completing({})
}

export async function optionsOf(run: (args: string[]) => Promise<number>): Promise<Options> {
  return (await completingOf(run)).options
}

function candidateLine(candidate: Candidate): string {
  return typeof candidate === 'string' ? candidate : candidate.join('\t')
}

// The positionals written before the last word, leaving out options and the values of string ones, and the name of the positional the last word is; the last name repeats when it ends in `...`.
function positionalBeingTyped(before: string[], { options, positionals }: Completing): { name: string | undefined, typed: string[] } {
  const takesValue = (word: string) => !word.includes('=') && Object.entries(options).some(([name, { short, type }]) => type === 'string' && (word === `--${name}` || word === `-${short}`))
  const typed: string[] = []
  let at = 0

  while (at < before.length) {
    const word = before[at]!

    if (word === '--') {
      typed.push(...before.slice(at + 1))

      break
    }

    if (!word.startsWith('-'))
      typed.push(word)
    else if (takesValue(word))
      at++

    at++
  }

  const last = positionals.at(-1)

  if (typed.length < positionals.length)
    return { name: positionals[typed.length], typed }

  return { name: last?.replace(']', '').endsWith('...') === true ? last : undefined, typed }
}

// A leaf command's candidates: the values of the string option just typed or of the positional being typed, else paths for a word not starting with a dash; its long options for one that does.
export async function leafCandidates(run: (args: string[]) => Promise<number>, words: string[]): Promise<string[]> {
  const completing = await completingOf(run)

  if ((words.at(-1) ?? '').startsWith('-'))
    return Object.entries(completing.options).map(([name, option]) => option.description === undefined ? `--${name}` : `--${name}\t${option.description}`)

  const flag = words.at(-2)
  const option = flag?.startsWith('-') === true ? Object.entries(completing.options).find(([name, { short }]) => flag === `--${name}` || flag === `-${short}`)?.[1] : undefined

  const { name, typed } = positionalBeingTyped(words.slice(0, -1), completing)

  if (option?.type === 'string') {
    const values = option.choices === undefined ? await option.candidates?.(typed) : option.choices

    return values === undefined ? [FILES] : values.map(candidateLine)
  }

  const values = name === undefined ? undefined : await completing.candidates[name]?.(typed)

  return values === undefined ? [FILES] : values.map(candidateLine)
}

// The candidates for the last word, `value\tdescription` per line, after walking the subcommands the earlier words name.
export async function candidates(scope: Scope, defaultCommand: string | undefined, words: string[], before: string[] = []): Promise<string[]> {
  const [word = '', ...rest] = words
  const listing = rest.length === 0 && !word.startsWith('-')
  let { commands } = scope
  let command = lookup(scope, word)

  if (listing || command === undefined) {
    const expanded = await expand(scope, [...before, ...words])

    commands = expanded.commands
    command = lookup(expanded, word)
  }

  if (listing) {
    const own = await Promise.all(Object.entries(shown(commands)).map(async ([name, { summary }]) => `${name}\t${await resolveSummary(summary)}`))
    const fallback = defaultCommand === undefined ? undefined : commands[defaultCommand]
    // What the default command takes as its first positional is typed here too, `app <project>`; a name a command already has is left out.
    const values = fallback !== undefined && 'run' in fallback ? await leafCandidates(fallback.run, [word]) : []

    const valueOf = (line: string) => line.slice(0, line.includes('\t') ? line.indexOf('\t') : undefined)

    return [...own, ...values.filter(line => line !== FILES && !Object.hasOwn(commands, valueOf(line)))]
  }

  if (command === undefined) {
    const fallback = defaultCommand === undefined ? undefined : commands[defaultCommand]

    return fallback !== undefined && 'run' in fallback ? leafCandidates(fallback.run, words) : []
  }

  return 'commands' in command ? candidates(scopeOf(command.commands, command.extraCommands, command.aliases), undefined, rest, [...before, word]) : leafCandidates(command.run, rest)
}

// The words after a leading `--flag`, or the value of `--flag=value` and the rest.
export function flagValue([flag = '', ...rest]: string[]): string[] {
  return flag.includes('=') ? [flag.slice(flag.indexOf('=') + 1), ...rest] : rest
}

export function printCompletionScript(name: string, args: string[], reportError: (prefix: string, message: string, hint?: string) => void): number {
  const shell = COMPLETION_SHELLS.find(each => each === args[0])

  if (shell === undefined || args.length !== 1) {
    reportError(name, `${COMPLETIONS} takes one of ${COMPLETIONS_SHELLS_LIST()}`, `${name} ${COMPLETIONS} fish`)

    return 2
  }

  console.log(completionScript(shell, [name]).trimEnd())

  return 0
}

function COMPLETIONS_SHELLS_LIST(): string {
  return COMPLETION_SHELLS.join(', ')
}

export async function printCandidates(found: Promise<string[]>): Promise<number> {
  for (const line of await found)
    console.log(line)

  return 0
}
