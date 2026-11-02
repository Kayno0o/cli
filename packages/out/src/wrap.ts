import { isPlain, splitCommand, tokenize } from '@kaynooo/cli-kit/shell'

const ASSIGNMENT = /^\w+=/
const EXCLUDED = /(?:^|\s)(?:--json|--help|--version|-h|--watch(?:-?all|=\S*)?|--watchAll)(?:\s|$)/
// A tool's short watch flag, kept apart as -w means something else for `make` and `docker`.
const SHORT_WATCH = /(?:^|\s)(?:\S*\/)?(?:tsc|tsgo|vue-tsc|vitest|jest)\s(?:.*\s)?-w(?:\s|$)/
// Recipes and targets that run until stopped, whose output would sit buffered until a timeout.
const LONG_RUNNING = /^(?:dev|watch|serve|start|up|run|preview|storybook)(?:[:-]\S*)?$/
const BUN_SCRIPT = /^(?:build|check|lint|typecheck|types|test|ci|verify|compile)(?::|$)/
const BUN_TOOLS = new Set(['tsc', 'tsgo', 'eslint', 'keslint', 'vitest', 'jest', 'prettier', 'playwright', 'biome', 'vue-tsc'])
const BUN_SUBCOMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'update', 'test', 'check', 'lint', 'build'])
const STDERR_MERGE = /\s+2>&1$/
const FILTERS = new Set(['tail', 'head', 'grep'])
// grep flags that print something other than the matching lines, which out's folding would not give back.
const GREP_SUMMARY = /^(?:-[a-zA-Z]*[cqlL]|--(?:count|quiet|silent|files-with(?:out)?-match(?:es)?)$)/
const PHP_VALUE_OPTIONS = new Set(['-d', '-c', '-z'])
const BUNX_VALUE_OPTIONS = new Set(['-p', '--package'])
// Options taking a value, per container command, so the service or container name after them is found.
const COMPOSE_VALUE_OPTIONS = new Set(['-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory', '--ansi', '--progress', '--parallel'])
const EXEC_VALUE_OPTIONS = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--index', '--detach-keys', '--name', '--entrypoint', '-v', '--volume', '-p', '--publish', '-l', '--label', '--cap-add', '--cap-drop', '--pull'])

type Rule = (args: string[]) => boolean

const always: Rule = () => true
const typecheck: Rule = ([sub]) => sub === 'typecheck'

const RULES: Record<string, Rule> = {
  'bun': ([sub, script]) => sub !== undefined && (BUN_SUBCOMMANDS.has(sub) || (sub === 'run' && script !== undefined && BUN_SCRIPT.test(script))),
  'bunx': (args) => {
    const [tool, ...rest] = afterOptions(args, BUNX_VALUE_OPTIONS)

    return tool !== undefined && (BUN_TOOLS.has(tool) || ((tool === 'nuxi' || tool === 'nuxt') && typecheck(rest)))
  },
  'tsc': always,
  'tsgo': always,
  'vue-tsc': always,
  'nuxi': typecheck,
  'nuxt': typecheck,
  'eslint': always,
  'keslint': always,
  'vitest': always,
  'jest': always,
  'pytest': always,
  'phpunit': always,
  'paratest': always,
  'phpstan': always,
  'pest': always,
  'php-cs-fixer': always,
  'rector': always,
  'php': args => listed(afterOptions(args, PHP_VALUE_OPTIONS)),
  'make': ([first]) => first === undefined || !LONG_RUNNING.test(first),
  'check': always,
  'just': ([first]) => first !== undefined && !first.startsWith('-') && !LONG_RUNNING.test(first),
  'composer': ([sub]) => sub === 'install' || sub === 'update' || sub === 'require',
  'pip': ([sub]) => sub === 'install',
  'cargo': ([sub]) => ['build', 'test', 'check', 'clippy'].includes(sub ?? ''),
  'go': ([sub]) => ['build', 'test', 'vet'].includes(sub ?? ''),
  'docker': (args) => {
    if (args[0] === 'build')
      return true

    if (args[0] === 'exec')
      return listed(afterOptions(args.slice(1), EXEC_VALUE_OPTIONS).slice(1))

    if (args[0] !== 'compose')
      return false

    const [sub, ...rest] = afterOptions(args.slice(1), COMPOSE_VALUE_OPTIONS)

    if (sub === 'exec' || sub === 'run')
      return listed(afterOptions(rest, EXEC_VALUE_OPTIONS).slice(1))

    return sub === 'build' || sub === 'pull'
  },
}

// The words from the first one that is not an option, skipping the value of the options listed as taking one.
function afterOptions(args: string[], valued: Set<string>): string[] {
  let index = 0

  while (args[index]?.startsWith('-') === true) {
    index += valued.has(args[index] ?? '') ? 2 : 1
  }

  return args.slice(index)
}

interface Scan {
  segments: string[]
  // False when the line pipes, redirects, backgrounds or substitutes, which wrapping would change.
  plain: boolean
  // Where each `|` outside quotes stands, `||` left out.
  pipes: number[]
}

// Splits on && || ; and newlines outside quotes and heredocs, a pipe keeping its stages in one segment.
function scan(command: string): Scan {
  const segments: string[] = []
  const pipes: number[] = []
  let current = ''
  let plain = true

  for (const piece of splitCommand(command)) {
    current += piece.text
    plain &&= isPlain(piece.text) && piece.separator !== '&'

    if (piece.separator === '|') {
      pipes.push(piece.end)
      current += '|'
      plain = false

      continue
    }

    segments.push(current)
    current = ''
  }

  return { segments: segments.map(segment => segment.trim()).filter(segment => segment !== ''), plain, pipes }
}

function isFilter(stage: string): boolean {
  const { segments, plain } = scan(stage)
  const [bin, ...args] = tokenize(stage)

  if (!plain || segments.length !== 1 || bin === undefined || !FILTERS.has(bin))
    return false

  return bin !== 'grep' || !args.some(arg => GREP_SUMMARY.test(arg))
}

// The line without its trailing `| tail`, `| head` and `| grep` stages and the `2>&1` feeding them, as out keeps the failures they would have picked out.
function withoutFilters(command: string): string {
  let rest = command

  for (let at = scan(rest).pipes.at(-1); at !== undefined && isFilter(rest.slice(at + 1).trim()); at = scan(rest).pipes.at(-1))
    rest = rest.slice(0, at).trimEnd().replace(STDERR_MERGE, '')

  return rest
}

function listed(words: string[]): boolean {
  const start = words.findIndex(word => !ASSIGNMENT.test(word))
  const path = words[start]

  if (path === undefined)
    return false

  // `vendor/bin/phpunit` and `./bin/phpunit` are phpunit.
  return RULES[path.slice(path.lastIndexOf('/') + 1)]?.(words.slice(start + 1)) ?? false
}

function listedSegment(segment: string): boolean {
  return !EXCLUDED.test(segment) && !SHORT_WATCH.test(segment) && listed(tokenize(segment))
}

// A `cd` ahead of the real command is harmless to wrap.
function isCd(segment: string): boolean {
  return segment === 'cd' || segment.startsWith('cd ')
}

// True when the line is made only of listed noisy commands (and cd), with no pipe, redirect, background or substitution, and at least one command is listed; a final pipe into tail, head or grep is dropped first.
export function shouldWrap(command: string): boolean {
  const { segments, plain } = scan(withoutFilters(command.trim()))

  if (!plain || !segments.some(segment => listedSegment(segment)))
    return false

  return segments.every(segment => isCd(segment) || listedSegment(segment))
}

function quoted(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

// The command line to run instead: `out -- <cmd>` without the final tail, head or grep pipe, through `sh -c` when it chains commands or starts with an assignment.
export function wrap(command: string): string {
  const trimmed = withoutFilters(command.trim())

  if (scan(trimmed).segments.length <= 1 && !ASSIGNMENT.test(trimmed))
    return `out -- ${trimmed}`

  return `out -- sh -c ${quoted(trimmed)}`
}
